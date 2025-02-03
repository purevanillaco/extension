// noinspection ES6MissingAwait

const state = self.serviceWorker.state

importScripts('libs/idb.umd.js')
importScripts('projects.js')
importScripts('main.js')
importScripts('siteRefresh.js')

const retryCooldown = 3600 * 1000 * 2

// TODO отложенный importScripts пока не работают, подробнее https://bugs.chromium.org/p/chromium/issues/detail?id=1198822
self.addEventListener('install', () => {
    importScripts('libs/linkedom.js')
    importScripts('scripts/mcserver-list.eu_silentvote.js', 'scripts/misterlauncher.org_silentvote.js', 'scripts/serverpact.com_silentvote.js', 'scripts/genshindrop.com_silentvote.js')
})

//Текущие fetch запросы
// noinspection ES6ConvertVarToLetConst
// var fetchProjects = new Map()
//ID группы вкладок в которой сейчас открыты вкладки расширения
let groupId
//Если этот браузер не поддерживает группировку вкладок
let notSupportedGroupTabs = false

//Нужно ли сейчас делать проверку голосования, false может быть только лишь тогда когда предыдущая проверка ещё не завершилась
let check = true
let doubleCheck = false

let silentResponseBody = {}

//Инициализация настроек расширения
// noinspection JSIgnoredPromiseFromCall
const initializeFunc = initializeConfig(true)
initializeFunc.finally(() => initializeFunc.done = true)

//Проверка: нужно ли голосовать, сверяет время текущее с временем из конфига
async function checkVote() {
    console.log('checkvote')

    await initializeFunc

    // noinspection JSUnresolvedReference
    if (!settings.operaAttention2 && (navigator?.userAgentData?.brands?.[0]?.brand === 'Opera' || (!!self.opr && !!opr.addons) || !!self.opera || navigator.userAgent.indexOf(' OPR/') >= 0)) {
        return
    }

    //Если после попытки голосования не было интернета, проверяется есть ли сейчас интернет и если его нет то не допускает последующую проверку но есои наоборот появился интернет, устаналвивает статус online на true и пропускает код дальше
    if (!settings.disabledCheckInternet && !onLine) {
        if (navigator.onLine) {
            console.log(chrome.i18n.getMessage('internetRestored'))
            onLine = true
            db.put('other', onLine, 'onLine')
        } else {
            setTimeout(async () => {
                await checkVote()
            }, 60 * 1000 + 50)
            return
        }
    }

    if (check) {
        check = false
    } else {
        doubleCheck = true
        return
    }

    const transaction = db.transaction('projects')
    let cursor = await transaction.objectStore('projects').openCursor()
    while (cursor) {
        const project = cursor.value
        if (!project.time || project.time < Date.now()) {
            await checkOpen(project, transaction)
        }
        // noinspection JSVoidFunctionReturnValueUsed
        cursor = await cursor.continue()
    }

    check = true
    if (doubleCheck) {
        doubleCheck = false
        checkVote()
    } else {
        // Голосование завершилось и более не планируется
        if (!openedProjects.size) {
            promises = []
            updateListeners(false)
        }
    }
}

chrome.idle.onStateChanged.addListener(async function (newState) {
    if (newState === 'active') {
        checkVote()
    }
})

let promises = []
async function checkOpen(project, transaction) {
    //Если нет интернета, то не голосуем
    if (!settings.disabledCheckInternet) {
        if (!navigator.onLine && onLine) {
            setTimeout(async () => {
                await checkVote()
            }, 60 * 1000 + 5);
            console.warn(getProjectPrefix(project, true), chrome.i18n.getMessage('internetDisconnected'))
            onLine = false
            db.put('other', onLine, 'onLine')
            return
        } else if (!onLine) {
            return
        }
    }

    for (let [tab, value] of openedProjects) {
        if (value.timeoutQueue && Date.now() >= value.timeoutQueue) {
            openedProjects.delete(tab)
            db.put('other', openedProjects, 'openedProjects')
            continue
        }
        if (project.rating === value.rating || (value.randomize && project.randomize) || settings.disabledOneVote) {
            if (settings.disabledRestartOnTimeout || tab.startsWith?.('queue_') || Date.now() < value.nextAttempt) {
                return
            } else {
                openedProjects.delete(tab)
                db.put('other', openedProjects, 'openedProjects')

                const projectTimeout = await transaction.objectStore('projects').get(value.key)
                if (!value.nextAttempt) {
                    console.warn(getProjectPrefix(projectTimeout, true), 'nextAttempt is undefined, maybe it\'s an error')
                }
                console.warn(getProjectPrefix(projectTimeout, true), chrome.i18n.getMessage('timeout'))
                if (!settings.disableCloseTabsOnError) tryCloseTab(tab, projectTimeout, 0)
                break
            }
        }
    }

    console.log('cleared next attempt 2')
    delete project.timeoutQueue
    delete project.nextAttempt
    delete project.countInject

    const opened = {}
    opened.key = project.key
    opened.rating = project.rating
    opened.countInject = 0
    if (project.randomize) opened.randomize = project.randomize

    if (!settings.disabledRestartOnTimeout) {
        opened.nextAttempt = Date.now() + retryCooldown
    }

    // Голосование запускается впервые
    if (!openedProjects.size) {
        updateListeners(true)
    }

    openedProjects.set('start_' + project.key, opened)
    db.put('other', openedProjects, 'openedProjects')

    if (settings.debug) console.log(getProjectPrefix(project, true), 'пред запуск')

    if (project.rating === 'monitoringminecraft.ru') {
        promises.push(clearMonitoringMinecraftCookies())
        async function clearMonitoringMinecraftCookies() {
            let url
            if (project.rating === 'monitoringminecraft.ru') {
                url = '.monitoringminecraft.ru'
            }
            let cookies = await chrome.cookies.getAll({ domain: url })
            if (settings.debug) console.log(chrome.i18n.getMessage('deletingCookies', url))
            for (let i = 0; i < cookies.length; i++) {
                if (cookies[i].domain.charAt(0) === '.') cookies[i].domain = cookies[i].domain.substring(1, cookies[i].domain.length)
                await chrome.cookies.remove({ url: 'https://' + cookies[i].domain + cookies[i].path, name: cookies[i].name })
            }
        }
    }

    // noinspection JSIgnoredPromiseFromCall
    newWindow(project, opened)
}

let promiseGroup
let promiseWindow
//Открывает вкладку для голосования или начинает выполнять fetch запросы


async function newWindow(project, opened) {
    //Ожидаем очистку куки
    let result = await Promise.all(promises)
    while (result.length < promises.length) {
        result = await Promise.all(promises)
    }

    console.log(getProjectPrefix(project, true), chrome.i18n.getMessage('startedAutoVote'))

    if (new Date(project.stats.lastAttemptVote).getMonth() < new Date().getMonth() || new Date(project.stats.lastAttemptVote).getFullYear() < new Date().getFullYear()) {
        project.stats.lastMonthSuccessVotes = project.stats.monthSuccessVotes
        project.stats.monthSuccessVotes = 0
    }
    project.stats.lastAttemptVote = Date.now()

    if (new Date(generalStats.lastAttemptVote).getMonth() < new Date().getMonth() || new Date(generalStats.lastAttemptVote).getFullYear() < new Date().getFullYear()) {
        generalStats.lastMonthSuccessVotes = generalStats.monthSuccessVotes
        generalStats.monthSuccessVotes = 0
    }
    generalStats.lastAttemptVote = Date.now()

    if (new Date(todayStats.lastAttemptVote).getDay() < new Date().getDay()) {
        todayStats = {
            successVotes: 0,
            errorVotes: 0,
            laterVotes: 0,
            lastSuccessVote: null,
            lastAttemptVote: null
        }
    }
    todayStats.lastAttemptVote = Date.now()
    await db.put('other', generalStats, 'generalStats')
    await db.put('other', todayStats, 'todayStats')
    await updateValue('projects', project)

    let silentVoteMode = false
    if (project.rating === 'Custom') {
        silentVoteMode = true
    } else if (!project.emulateMode && allProjects[project.rating].silentVote?.(project)) {
        silentVoteMode = true
    }
    if (silentVoteMode) {
        openedProjects.set('background_' + project.key, opened)
        openedProjects.delete('start_' + project.key)
        db.put('other', openedProjects, 'openedProjects')
        silentVote(project)
    } else {
        let result = await promiseWindow
        if (result === false) return
        promiseWindow = checkWindow(project)
        result = await promiseWindow
        if (result === false) return

        const url = allProjects[project.rating].voteURL(project)

        let tab = await tryOpenTab({ url, active: settings.disabledFocusedTab || Boolean(allProjects[project.rating].focusedTab?.(project)) }, project, 0)
        if (tab == null) return
        openedProjects.set(tab.id, opened)
        openedProjects.delete('start_' + project.key)
        db.put('other', openedProjects, 'openedProjects')

        setTimeout(async () => {
            try {
                groupTabs(tab)
            } catch (error) {
                console.log(error)
            }
        }, 1000 * 30);

        setTimeout(async () => {
            try {
                const tabInfo = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab.id !== tabInfo[0].id) {
                    try {
                        await chrome.tabs.remove(tab.id);
                    } catch (error) {

                    }
                } else {
                    console.log('Tab is focused, not removing');
                }
            } catch (error) {

            }
        }, 1000 * 60)
    }
}

let managingGroup = false;
async function groupTabs(tab) {
    // Unpin and move tab to the end
    tab = await chrome.tabs.update(tab.id, { pinned: false });
    const tabs = await chrome.tabs.query({ currentWindow: true });
    await chrome.tabs.move(tab.id, { index: tabs.length });

    // Synchronized group management
    while (managingGroup) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
        managingGroup = true;

        const groups = await chrome.tabGroups.query({ title: 'Manual Voting' });
        let groupId = groups[0]?.id;

        // Remove extra groups if they exist
        if (groups.length > 1) {
            for (let i = 1; i < groups.length; i++) {
                try {
                    await chrome.tabs.ungroup(groups[i].tabs);
                } catch { }
            }
        }

        // Create group if no group exists
        if (!groupId) {
            groupId = await chrome.tabs.group({ tabIds: tab.id });
            await chrome.tabGroups.update(groupId, { color: 'green', title: 'Manual Voting' });
        }

        // Add tab to group with retry
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await chrome.tabs.group({ groupId, tabIds: tab.id });
                return;
            } catch (error) {
                if (
                    error.message !== 'Tabs cannot be edited right now (user may be dragging a tab).' ||
                    attempt === 2
                ) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    } finally {
        managingGroup = false;
    }
}

async function checkWindow(project) {
    const windows = await chrome.windows.getAll()
        .catch(error => console.warn(chrome.i18n.getMessage('errorOpenTab', error.message)))
    if (!windows?.length) {
        try {
            const window = await chrome.windows.create({ focused: false })
            await chrome.windows.update(window.id, { focused: false, drawAttention: false })
        } catch (error) {
            endVote({ errorOpenTab: error.message }, null, project)
            return false
        }
    }
    return true
}

async function silentVote(project) {
    if (!self.DOMParser) {
        importScripts('libs/linkedom.js')
    }
    try {
        if (project.rating === 'Custom') {
            let response = await fetch(project.responseURL, { ...project.body })
            await response.text()
            if (response.ok) {
                endVote({ successfully: true }, null, project)
            } else {
                endVote({ errorVote: [String(response.status), response.url] }, null, project)
            }
            return
        }

        if (!self['silentVote' + project.rating]) {
            importScripts('scripts/' + (project.ratingMain || project.rating) + '_silentvote.js')
        }

        await self['silentVote_' + project.rating](project)
    } catch (error) {
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) {
            // let found = false
            // for (const p of fetchProjects.values()) {
            //     if (p.key === project.key) {
            //         found = true
            //         break
            //     }
            // }
            // if (!found) {
            endVote({ notConnectInternet: true }, null, project)
            // endVote({message: chrome.i18n.getMessage('errorVoteUnknown') + (error.stack ? error.stack : e)}, null, project)
            // }
        } else {
            let message
            if (error.stack) {
                message = error.stack
            } else {
                message = error.message
            }
            const request = {}
            request.errorVoteNoElement = message
            if (silentResponseBody[project.rating]) {
                request.html = silentResponseBody[project.rating].doc.body.outerHTML
                request.url = silentResponseBody[project.rating].url
            }
            endVote(request, null, project)
        }
    } finally {
        delete silentResponseBody[project.rating]
    }
}

async function checkResponseError(project, response, url, bypassCodes, vk) {
    let host = extractHostname(response.url)
    if (vk && host.includes('vk.com')) {
        if (response.headers.get('Content-Type') && response.headers.get('Content-Type').includes('windows-1251')) {
            //Почему не UTF-8?
            response = await new Response(new TextDecoder('windows-1251').decode(await response.arrayBuffer()))
        }
    }
    response.html = await response.text()
    response.doc = new DOMParser().parseFromString(response.html, 'text/html')
    silentResponseBody[project.rating] = {}
    silentResponseBody[project.rating].doc = response.doc
    silentResponseBody[project.rating].url = response.url
    if (vk && host.includes('vk.com')) {
        //Узнаём причину почему мы зависли на авторизации ВК
        let text
        if (response.doc.querySelector('div.oauth_form_access') != null) {
            text = response.doc.querySelector('div.oauth_form_access').textContent.replace(response.doc.querySelector('div.oauth_access_items').textContent, '').trim()
        } else if (response.doc.querySelector('div.oauth_content > div') != null) {
            text = response.doc.querySelector('div.oauth_content > div').textContent
        } else if (response.doc.querySelector('#login_blocked_wrap') != null) {
            text = response.doc.querySelector('#login_blocked_wrap div.header').textContent + ' ' + response.doc.querySelector('#login_blocked_wrap div.content').textContent.trim()
        } else if (response.doc.querySelector('div.login_blocked_panel') != null) {
            text = response.doc.querySelector('div.login_blocked_panel').textContent.trim()
        } else if (response.doc.querySelector('.profile_deleted_text') != null) {
            text = response.doc.querySelector('.profile_deleted_text').textContent.trim()
        } else if (response.html.length < 500) {
            text = response.html
        } else {
            text = 'null'
        }
        endVote({ errorAuthVK: text }, null, project)
        return false
    }
    if (!host.includes(url)) {
        endVote({ message: chrome.i18n.getMessage('errorRedirected', response.url) }, null, project)
        return false
    }
    if (bypassCodes) {
        for (const code of bypassCodes) {
            if (response.status === code) {
                return true
            }
        }
    }
    if (!response.ok) {
        endVote({ errorVote: [String(response.status), response.url] }, null, project)
        return false
    }
    if (response.statusText && response.statusText !== '' && response.statusText !== 'ok' && response.statusText !== 'OK') {
        endVote(response.statusText, null, project)
        return false
    }
    return true
}

const webNavigationOnCommittedListener = function (details) {
    if (!initializeFunc.done) {
        (async () => {
            await initializeFunc
            let opened = openedProjects.get(details.tabId)
            if (!opened) return
            const project = await db.get('projects', opened.key)
            let message = chrome.i18n.getMessage('notReadyInject')
            if (project.error === message) return
            console.warn(getProjectPrefix(project, true), message)
            project.error = message
            updateValue('projects', project)
        })()
        return
    }

    let opened = openedProjects.get(details.tabId)
    if (!opened) return
    if (details.url.startsWith('blob:')) return
    const filesIsolated = []
    const filesMain = []
    if (details.frameId === 0) {
        // Через эти сайты пользователь может авторизоваться, я пока не поддерживаю автоматическую авторизацию, не мешаем ему в авторизации
        if (details.url.match(/facebook.com\/*/) || details.url.match(/google.com\/*/) || details.url.match(/accounts.google.com\/*/) || details.url.match(/reddit.com\/*/) || details.url.match(/twitter.com\/*/)) {
            return
        }
        // Если пользователь авторизовывается через эти сайты, но у расширения на это нет прав, всё равно не мешаем ему, пускай сам авторизуется не смотря, на то что есть автоматизация авторизации
        // if (details.url.match(/vk.com\/*/) || details.url.match(/discord.com\/*/) || details.url.startsWith('https://steamcommunity.com/openid/login') || details.url.startsWith('https://steamcommunity.com/login/home')) {
        //     // noinspection JSUnresolvedFunction
        //     let granted = await chrome.permissions.contains({origins: [details.url]})
        //     if (!granted) {
        //         return
        //     }
        // }

        filesMain.push('scripts/main/visible.js')
        if (allProjects[getDomainWithoutSubdomain(details.url)]?.needIsTrusted?.()) {
            filesIsolated.push('scripts/main/istrusted_isolated.js')
            filesMain.push('scripts/main/istrusted_main.js')
        }
        if (!allProjects[getDomainWithoutSubdomain(details.url)]?.dontUseAlert?.()) {
            filesIsolated.push('scripts/main/alert_isolated.js')
            filesMain.push('scripts/main/alert_main.js')
        }
    } else if (details.url.match(/hcaptcha.com\/captcha\/*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/enterprise\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/enterprise\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/enterprise\/bframe*/)
        || details.url.match(/https:\/\/challenges.cloudflare.com\/*/)) {
        filesMain.push('scripts/main/visible.js')
        filesIsolated.push('scripts/main/alert_isolated.js')
        filesMain.push('scripts/main/alert_main.js')
    }

    if (!filesIsolated.length && !filesMain.length) return

    if (settings.debug) console.log('Injecting ' + JSON.stringify(filesIsolated) + ', ' + JSON.stringify(filesMain) + ' to ' + details.url)

    let target = { tabId: details.tabId }
    if (details.frameId) target.frameIds = [details.frameId]

    if (filesIsolated.length) {
        chrome.scripting.executeScript({ target, files: filesIsolated, injectImmediately: true }, () => {
            const error = chrome.runtime.lastError
            if (error) {
                catchTabError(error, opened)
            }
        })
    }
    if (filesMain.length) {
        chrome.scripting.executeScript({ target, files: filesMain, world: 'MAIN', injectImmediately: true }, () => {
            const error = chrome.runtime.lastError
            if (error) {
                catchTabError(error, opened)
            }
        })
    }
}

//Слушатель на обновление вкладок, если вкладка полностью загрузилась, загружает туда скрипт который сам нажимает кнопку проголосовать
const webNavigationOnCompletedListener = async function (details) {
    await initializeFunc
    let opened = openedProjects.get(details.tabId)
    if (!opened) return

    if (details.frameId === 0) {
        // Через эти сайты пользователь может авторизоваться, я пока не поддерживаю автоматическую авторизацию, не мешаем ему в авторизации
        if (details.url.match(/facebook.com\/*/) || details.url.match(/google.com\/*/) || details.url.match(/accounts.google.com\/*/) || details.url.match(/reddit.com\/*/) || details.url.match(/twitter.com\/*/)) {
            return
        }

        const project = await db.get('projects', opened.key)

        // Если пользователь авторизовывается через эти сайты, но у расширения на это нет прав, всё равно не мешаем ему, пускай сам авторизуется не смотря, на то что есть автоматизация авторизации
        // if (details.url.match(/vk.com\/*/) || details.url.match(/discord.com\/*/) || details.url.startsWith('https://steamcommunity.com/openid/login') || details.url.startsWith('https://steamcommunity.com/login/home')) {
        //     // noinspection JSUnresolvedFunction
        //     let granted = await chrome.permissions.contains({origins: [details.url]})
        //     if (!granted) {
        //         console.warn(getProjectPrefix(project, true), 'Not granted permissions for ' + details.url)
        //         return
        //     }
        // }

        if (opened.countInject >= 10) {
            endVote({ tooManyVoteAttempts: true }, { tab: { id: details.tabId }, url: details.url }, opened)
            return
        }

        try {
            if (allProjects[project.rating]?.needPrompt?.()) {
                const funcPrompt = function (nick) {
                    // noinspection JSUnusedLocalSymbols
                    window.prompt = new Proxy(window.prompt, {
                        apply(target, thisArg, argArray) {
                            return nick
                        }
                    })
                }
                if (settings.debug) console.log('Injecting funcPrompt to ' + details.url)
                await chrome.scripting.executeScript({ target: { tabId: details.tabId }, world: 'MAIN', func: funcPrompt, args: [project.nick] })
            }

            if (settings.debug) console.log('Injecting scripts/' + project.rating.toLowerCase() + '.js, scripts/main/api.js to ' + details.url)
            await chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['scripts/main/hacktimer.js', 'scripts/' + (project.ratingMain || project.rating) + '.js', 'scripts/main/api.js'] })
            // noinspection JSUnresolvedVariable,JSUnresolvedFunction
            if (allProjects[project.rating]?.needWorld?.()) {
                if (settings.debug) console.log('Injecting scripts/' + project.rating.toLowerCase() + '_world.js to ' + details.url + ' in MAIN world')
                await chrome.scripting.executeScript({ target: { tabId: details.tabId }, world: 'MAIN', files: ['scripts/' + (project.ratingMain || project.rating) + '_world.js'] })
            }

            await chrome.tabs.sendMessage(details.tabId, { sendProject: true, project, settings })

            if (openedProjects.has(details.tabId)) {
                opened.countInject++
                db.put('other', openedProjects, 'openedProjects')
            }
        } catch (error) {
            catchTabError(error, project)
        }
    } else if (details.frameId !== 0 && (
        details.url.match(/hcaptcha.com\/captcha\/*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/enterprise\/fallback*/)
        || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/enterprise\/anchor*/)
        || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/enterprise\/bframe*/)
        || details.url.match(/https:\/\/challenges.cloudflare.com\/*/))) {

        const project = await db.get('projects', opened.key)

        try {
            if (settings.debug) console.log('Injecting scripts/main/captchaclicker.js to ' + details.url)
            await chrome.scripting.executeScript({ target: { tabId: details.tabId, frameIds: [details.frameId] }, files: ['scripts/main/hacktimer.js', 'scripts/main/captchaclicker.js'] })

            // Если вкладка уже загружена, повторно туда высылаем sendProject который обозначает что мы готовы к голосованию
            const tab = await chrome.tabs.get(details.tabId)
            // TODO костыльная совместимость с Kiwi Browser, данный браузер в tab.status отдаёт undefined, нам ничего не остаётся кроме как игнорировать данный факт и голосовать как есть
            // не работоспособность данной проверки может привести к тому что капча может быть решена раньше чем страница загружена но такое обстоятельство весьма редкое
            // расширение отошлёт сообщение о пройденной капче ещё не внедрённому скрипту голосования что приведёт к зависанию голосования
            // например сайт ionmc.top загружает капчу раньше чем страница загрузилась
            if (tab.status != null && tab.status !== 'complete') return
            await chrome.tabs.sendMessage(details.tabId, { sendProject: true, project, settings })
        } catch (error) {
            catchTabError(error, project)
        }
    }
}

async function catchTabError(error, project) {
    if (error.message !== 'The frame was removed.' && !error.message.includes('No frame with id') && error.message !== 'The tab was closed.' && !error.message.includes('PrecompiledScript.executeInGlobal')/*Для FireFox мы игнорируем эту ошибку*/ && !error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received') && (!error.message.includes('Frame with ID') && !error.message.includes('was removed'))) {
        project = await db.get('projects', project.key)
        let message = error.message
        if (message.includes('This page cannot be scripted due to an ExtensionsSettings policy')) {
            message += ' Try this solution: https://github.com/Serega007RU/Auto-Vote-Rating/wiki/Problems-with-Opera'
        }
        console.error(getProjectPrefix(project, true), error.message)
        project.error = message
        updateValue('projects', project)
    }
}

const tabsOnRemovedListener = async function (tabId) {
    await initializeFunc
    let opened = openedProjects.get(tabId)
    if (!opened) return
    endVote({ closedTab: true }, { tab: { id: tabId } }, opened)
}

const webRequestOnCompletedListener = async function (details) {
    await initializeFunc
    let opened = openedProjects.get(details.tabId)
    if (!opened) return

    // Иногда некоторые проекты намеренно выдаёт ошибку в status code, нам ничего не остаётся кроме как игнорировать все ошибки, подробнее https://discord.com/channels/371699266747629568/760393040174120990/1053016256535593022
    if (allProjects[opened.rating].ignoreErrors?.()) return

    if (details.type === 'main_frame' && (details.statusCode < 200 || details.statusCode > 299)) {
        if (details.statusCode === 503 || details.statusCode === 403) { // Если проверка CloudFlare
            opened.countInject--
            db.put('other', openedProjects, 'openedProjects')
        } else {
            const sender = { tab: { id: details.tabId }, url: details.url }
            endVote({ errorVote: [String(details.statusCode), details.url] }, sender, opened)
        }
    }
}

const webRequestOnErrorOccurredListener = async function (details) {
    await initializeFunc
    // noinspection JSUnresolvedVariable
    /*if ((details.initiator && details.initiator.includes(self.location.hostname) || (details.originUrl && details.originUrl.includes(self.location.hostname))) && fetchProjects.has(details.requestId)) {
        let project = fetchProjects.get(details.requestId)
        endVote({errorVoteNetwork: [details.error, details.url]}, null, project)
    } else */if (openedProjects.has(details.tabId)) {
        if (details.type === 'main_frame' || details.url.match(/hcaptcha.com\/captcha\/*/) || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/*/) || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/*/) || details.url.match(/https:\/\/challenges.cloudflare.com\/*/)) {
            const opened = openedProjects.get(details.tabId)
            if (
                //Chrome
                details.error.includes('net::ERR_ABORTED') || details.error.includes('net::ERR_CONNECTION_RESET') || details.error.includes('net::ERR_NETWORK_CHANGED') || details.error.includes('net::ERR_CACHE_MISS') || details.error.includes('net::ERR_BLOCKED_BY_CLIENT') || details.error.includes('net::ERR_QUIC_PROTOCOL_ERROR')
                //FireFox
                || details.error.includes('NS_BINDING_ABORTED') || details.error.includes('NS_ERROR_NET_ON_RESOLVED') || details.error.includes('NS_ERROR_NET_ON_RESOLVING') || details.error.includes('NS_ERROR_NET_ON_WAITING_FOR') || details.error.includes('NS_ERROR_NET_ON_CONNECTING_TO') || details.error.includes('NS_ERROR_FAILURE') || details.error.includes('NS_ERROR_DOCSHELL_DYING') || details.error.includes('NS_ERROR_NET_ON_TRANSACTION_CLOSE')) {
                // console.warn(getProjectPrefix(project, true), details.error)
                return
            }
            const sender = { tab: { id: details.tabId }, url: details.url }
            endVote({ errorVoteNetwork: [details.error, details.url] }, sender, opened)
        }
    }
}

const webNavigationOnErrorOccurredListener = async function (details) {
    await initializeFunc
    if (openedProjects.has(details.tabId)) {
        if (details.frameId === 0 || details.url.match(/hcaptcha.com\/captcha\/*/) || details.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/*/) || details.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/*/) || details.url.match(/https:\/\/challenges.cloudflare.com\/*/)) {
            const opened = openedProjects.get(details.tabId)
            if (
                //Chrome
                details.error.includes('net::ERR_ABORTED') || details.error.includes('net::ERR_CONNECTION_RESET') || details.error.includes('net::ERR_NETWORK_CHANGED') || details.error.includes('net::ERR_CACHE_MISS') || details.error.includes('net::ERR_BLOCKED_BY_CLIENT')
                //FireFox
                || details.error.includes('NS_BINDING_ABORTED') || details.error.includes('NS_ERROR_NET_ON_RESOLVED') || details.error.includes('NS_ERROR_NET_ON_RESOLVING') || details.error.includes('NS_ERROR_NET_ON_WAITING_FOR') || details.error.includes('NS_ERROR_NET_ON_CONNECTING_TO') || details.error.includes('NS_ERROR_FAILURE') || details.error.includes('NS_ERROR_DOCSHELL_DYING') || details.error.includes('NS_ERROR_NET_ON_TRANSACTION_CLOSE')) {
                // console.warn(getProjectPrefix(project, true), details.error)
                return
            }
            const sender = { tab: { id: details.tabId }, url: details.url }
            endVote({ errorVoteNetwork: [details.error, details.url] }, sender, opened)
        }
    }
}

// Регистрация и разрегистрация слушателей сделана в целях оптимизации работы фонового процесса расширения
// Фоновый процесс расширения слишком часто пробуждается лишний раз при веб сёрфинге (при использовании браузера пользователем)
// поэтому если голосование в данный момент не происходит - мы отключаем все эти слушатели и спим
// в случае если голосование запускается вновь - мы обратно регистрируем слушателей на время авто-голосования
function updateListeners(enable) {
    if (settings?.debug) console.log('Регистрация слушателей, включение', enable, 'openedProjects.size', openedProjects.size, 'openedProjects', openedProjects)
    if (enable) {
        if (!chrome.webNavigation.onErrorOccurred.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя webNavigation.onErrorOccurred')
            chrome.webNavigation.onErrorOccurred.addListener(webNavigationOnErrorOccurredListener)
        }
        if (!chrome.webNavigation.onCommitted.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя webNavigation.onCommitted')
            chrome.webNavigation.onCommitted.addListener(webNavigationOnCommittedListener)
        }
        if (!chrome.webNavigation.onCompleted.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя webNavigation.onCompleted')
            chrome.webNavigation.onCompleted.addListener(webNavigationOnCompletedListener)
        }
        if (!chrome.tabs.onRemoved.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя tabs.onRemoved')
            chrome.tabs.onRemoved.addListener(tabsOnRemovedListener)
        }
        if (!chrome.webRequest.onCompleted.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя webRequest.onCompleted')
            chrome.webRequest.onCompleted.addListener(webRequestOnCompletedListener, { urls: ['<all_urls>'] })
        }
        if (!chrome.webRequest.onErrorOccurred.hasListeners()) {
            if (settings?.debug) console.log('Регистрация слушателя webRequest.onErrorOccurred')
            chrome.webRequest.onErrorOccurred.addListener(webRequestOnErrorOccurredListener, { urls: ['<all_urls>'] })
        }
    } else {
        chrome.webNavigation.onErrorOccurred.removeListener(webNavigationOnErrorOccurredListener)
        chrome.webNavigation.onCommitted.removeListener(webNavigationOnCommittedListener)
        chrome.webNavigation.onCompleted.removeListener(webNavigationOnCompletedListener)
        chrome.tabs.onRemoved.removeListener(tabsOnRemovedListener)
        chrome.webRequest.onCompleted.removeListener(webRequestOnCompletedListener)
        chrome.webRequest.onErrorOccurred.removeListener(webRequestOnErrorOccurredListener)
    }
}

// Так как Service Worker может уснуть прямо во время голосования, мы прям при запуске всё равно регистрируем слушателей
// после инициализации базы данных если обнаруживается что сейчас мы не голосуем и нет необходимости голосовать - мы разрегистрируем слушатели
updateListeners(true)

async function handlePurevanillaMessage(request, sender, sendResponse) {
    // Ensure message is in expected format
    if (!request || request.type !== "FROM_PAGE") return;

    // Ensure sender's tab URL is from purevanilla.co
    if (sender.tab && !sender.tab.url.startsWith("https://purevanilla.co")) {
        return;
    }

    console.log("Received valid message from purevanilla.co:", request.text);
    if (awaitingEid) {
        const transaction = pvDb.transaction("user", "readwrite");
        const store = transaction.objectStore("user");
        const { eid } = JSON.parse(request.text)
        if (await store.get("eid") != eid) {
            await store.put({ id: "eid", value: eid });
            await chrome.tabs.remove(sender.tab.id);
        }
        await refreshNow()
    }
    return true;
}

chrome.runtime.onMessage.addListener(async function (request, sender, sendResponse) {
    if (await handlePurevanillaMessage(request, sender, sendResponse)) return;
    // noinspection JSIgnoredPromiseFromCall
    await onRuntimeMessage(request, sender, sendResponse)
    if (request.projectDeleted || request.projectRestart) {
        return true
    }
})

let fakeIdToId = {};
async function onRuntimeMessage(request, sender, sendResponse) {
    if (request.reloadCaptcha) {
        // noinspection JSVoidFunctionReturnValueUsed,JSCheckFunctionSignatures
        const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id })
        for (const frame of frames) {
            // noinspection JSUnresolvedVariable
            if (frame.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/api.\/anchor*/) || frame.url.match(/https?:\/\/(.+?\.)?recaptcha.net\/recaptcha\/api.\/anchor*/) || frame.url.match(/https?:\/\/(.+?\.)?google.com\/recaptcha\/enterprise\/anchor*/)) {
                function reload() {
                    document.location.reload()
                }

                if (settings.debug) { // noinspection JSUnresolvedReference
                    console.log('Injecting funcReloadCaptcha to ' + frame.url)
                }
                // noinspection JSCheckFunctionSignatures,JSUnresolvedVariable
                await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [frame.frameId] }, func: reload })
            }
        }
        return
    } else if (request.captchaPassed) {
        try {
            await chrome.tabs.sendMessage(sender.tab.id, request)
        } catch (error) {
            if (!error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                console.warn(error.message)
            }
        }
        if (request.captchaPassed !== 'double') return
    } else if (request.HackTimer) {
        if (request.name === 'setInterval') {
            fakeIdToId[request.fakeId] = setInterval(function () {
                triggerTimer(request.name, sender, request.fakeId);
            }, request.time);
        } else if (request.name === 'clearInterval') {
            clearInterval(fakeIdToId[request.fakeId]);
            delete fakeIdToId[request.fakeId];
        } else if (request.name === 'setTimeout') {
            fakeIdToId[request.fakeId] = setTimeout(function () {
                triggerTimer(request.name, sender, request.fakeId);
                delete fakeIdToId[request.fakeId];
            }, request.time);
        } else if (request.name === 'clearTimeout') {
            clearTimeout(fakeIdToId[request.fakeId]);
            delete fakeIdToId[request.fakeId];
        }
        return
    }

    await initializeFunc

    if (request === 'checkVote') {
        checkVote()
        return
    } else if (request === 'reloadAllSettings') {
        return
    } else if (request === 'reloadSettings') {
        settings = await db.get('other', 'settings')
        return
    } else if (request.projectDeleted) {
        const transaction = db.transaction(['projects', 'other'], 'readwrite')
        let nowVoting = false
        //Если эта вкладка была уже открыта, он закрывает её
        for (const [key, value] of openedProjects) {
            if (request.projectDeleted.key === value.key) {
                if (key === 'start_' + request.projectDeleted.key) {
                    sendResponse('reject')
                    return
                }
                nowVoting = true
                openedProjects.delete(key)
                tryCloseTab(key, request.projectDeleted, 0)
                await transaction.objectStore('other').put(openedProjects, 'openedProjects')
                break
            }
        }
        await transaction.objectStore('projects').delete(request.projectDeleted.key)
        if (nowVoting) {
            checkVote()
            console.log(getProjectPrefix(request.projectDeleted, true), chrome.i18n.getMessage('projectDeleted'))
        }
        sendResponse('success')
        return
    } else if (request.projectRestart) {
        const transaction = db.transaction(['projects', 'other'], 'readwrite')
        for (const [key, value] of openedProjects) {
            if (request.projectRestart.key === value.key) {
                if (request.confirmed) {
                    openedProjects.delete(key)
                    transaction.objectStore('other').put(openedProjects, 'openedProjects')
                    tryCloseTab(key, request.projectRestart, 0)
                    console.log(getProjectPrefix(request.projectRestart, true), chrome.i18n.getMessage('canceledVote'))
                } else {
                    sendResponse('confirmNow')
                    return
                }
            }
        }
        for (const [key, value] of openedProjects) {
            if (request.projectRestart.rating === value.rating || settings.disabledOneVote) {
                if (request.confirmed) {
                    openedProjects.delete(key)
                    await transaction.objectStore('other').put(openedProjects, 'openedProjects')
                    const project = await transaction.objectStore('projects').get(value.key)
                    tryCloseTab(key, project, 0)
                    console.log(getProjectPrefix(project, true), chrome.i18n.getMessage('canceledVote'))
                } else {
                    sendResponse('confirmQueue')
                    return
                }
            }
        }

        request.projectRestart.time = null
        await updateValue('projects', request.projectRestart)
        console.log(getProjectPrefix(request.projectRestart, true), chrome.i18n.getMessage('projectRestarted'))
        checkOpen(request.projectRestart)
        checkVote()
        sendResponse('success')
        return
    }

    if (request.changeProject) {
        updateValue('projects', request.changeProject)
        return
    }

    if (!openedProjects.has(sender.tab.id)) {
        console.warn('A double attempt to complete the vote? chrome.runtime.onMessage', JSON.stringify(request), JSON.stringify(sender))
        return
    }

    let opened = openedProjects.get(sender.tab.id)
    if (request.captcha || request.authSteam || request.discordLogIn || request.auth || request.requiredConfirmTOS || (request.errorCaptcha && !request.restartVote) || request.restartVote === false || request.captchaPassed === 'double') {//Если требует ручное прохождение капчи
        const project = await db.get('projects', opened.key)
        let message
        if (request.captcha) {
            message = chrome.i18n.getMessage('requiresCaptcha')
        } else if (request.captchaPassed === 'double') {
            message = chrome.i18n.getMessage('captchaPassedDouble')
        } else if (request.message) {
            message = request.message
        } else {
            if (Object.values(request)[0] !== true) {
                message = chrome.i18n.getMessage(Object.keys(request)[0], Object.values(request)[0])
            } else {
                message = chrome.i18n.getMessage(Object.keys(request)[0])
            }
        }
        if (!(request.captcha && settings.disabledWarnCaptcha)) {
            console.warn(getProjectPrefix(project, true), message)
            project.error = message
        }
        updateValue('projects', project)
    } else {
        endVote(request, sender, opened)
    }
}

async function triggerTimer(name, sender, fakeId) {
    try {
        await chrome.tabs.sendMessage(sender.tab.id, { HackTimer: true, fakeId }, { documentId: sender.documentId, frameId: sender.frameId });
    } catch (error) {
        if (name === 'setInterval') clearInterval(fakeIdToId[fakeId]);
        delete fakeIdToId[fakeId];
    }
}

async function tryOpenTab(request, project, attempt) {
    try {
        return await chrome.tabs.create({
            ...request,
            pinned: true,
        })
    } catch (error) {
        if (error.message === 'Tabs cannot be edited right now (user may be dragging a tab).' && attempt < 3) {
            await wait(500)
            return await tryOpenTab(request, project, ++attempt)
        }
        endVote({ errorOpenTab: error.message }, null, project)
        return null
    }
}

async function tryCloseTab(tabId, project, attempt) {
    if (!Number.isInteger(tabId)) return
    try {
        await chrome.tabs.remove(tabId)
    } catch (error) {
        if (error.message === 'Tabs cannot be edited right now (user may be dragging a tab).' && attempt < 3) {
            await wait(500)
            await tryCloseTab(tabId, project, ++attempt)
            return
        }
        if (!error.message.includes('No tab with id')) {
            console.warn(getProjectPrefix(project, true), error.message)
        }
    }
}

//Завершает голосование, если есть ошибка то обрабатывает её
async function endVote(request, sender, project) {
    let timeout = settings.timeout

    let opened
    for (const [tab, value] of openedProjects) {
        if (project.key === value.key) {
            if (!Number.isInteger(tab) && !tab.startsWith('background_') && !tab.startsWith('start_')) {
                console.warn('A double attempt to complete the vote? endVote, has openedProjects', JSON.stringify(request), JSON.stringify(sender), JSON.stringify(project))
                return
            } else {
                opened = value
                if (opened.randomize) {
                    timeout += Math.floor(Math.random() * (60000 - 10000) + 10000)
                }
                opened.timeoutQueue = Date.now() + timeout

                console.log('ended vote')
                delete opened.nextAttempt
                delete opened.countInject

                openedProjects.set('queue_' + opened.key, opened)
                openedProjects.delete(tab)
                db.put('other', openedProjects, 'openedProjects')
            }
            break
        }
    }
    if (!opened) {
        console.warn('A double attempt to complete the vote? endVote, not found openedProjects', JSON.stringify(request), JSON.stringify(sender), JSON.stringify(project))
        return
    }

    project = await db.get('projects', project.key)

    if (!request.successfully && request.later == null) {
        if (sender?.url || request.url) {
            const url = sender?.url || request.url
            const domain = getDomainWithoutSubdomain(url)
            // Если мы попали не по адресу, ну значит не надо отсылать отчёт об ошибке
            if (domain !== project.rating) {
                request.incorrectDomain = domain
            }
        }
    }

    if (sender && !request.closedTab) {
        if (!request.successfully && request.later == null) {
            if (!settings.disableCloseTabsOnError) tryCloseTab(sender.tab.id, project, 0)
        } else {
            if (!settings.disableCloseTabsOnSuccess) tryCloseTab(sender.tab.id, project, 0)
        }
    }

    // for (const[key,value] of fetchProjects) {
    //     if (value.key === project.key) {
    //         fetchProjects.delete(key)
    //     }
    // }

    // Повторно достаём project так как за время отправки отчёта или использования удалённого кода он мог измениться
    project = await db.get('projects', project.key)

    //Если усё успешно
    if (request.successfully || request.later != null) {

        // never vote again until the sites are refreshed
        project.time = Infinity
        delete project.error
        delete project.warn

        if (request.successfully) {
            if (typeof request.successfully === 'string') {
                project.warn = request.successfully
            }

            project.stats.successVotes++
            project.stats.monthSuccessVotes++
            project.stats.lastSuccessVote = Date.now()

            generalStats.successVotes++
            generalStats.monthSuccessVotes++
            generalStats.lastSuccessVote = Date.now()
            todayStats.successVotes++
            todayStats.lastSuccessVote = Date.now()
        } else {
            if (typeof request.later === 'string') {
                project.warn = request.later
            }

            project.stats.laterVotes++

            generalStats.laterVotes++
            todayStats.laterVotes++
        }
        //Если ошибка
    } else {
        let message
        if (!request.message) {
            const name = Object.keys(request)[0]
            if (Object.values(request)[0] === true) {
                message = chrome.i18n.getMessage(name)
            } else {
                message = chrome.i18n.getMessage(name, Object.values(request)[0])
            }
            if (request.usedTranslator && name !== 'usedTranslator') {
                message += ' ' + chrome.i18n.getMessage('usedTranslator')
            }
        } else {
            message = chrome.i18n.getMessage('siteError', request.message)
        }
        if (message.length === 0) message = chrome.i18n.getMessage('emptyError')
        if (request.incorrectDomain) {
            message += ' Incorrect domain ' + request.incorrectDomain
        }

        project.error = message

        project.stats.errorVotes++

        generalStats.errorVotes++
        todayStats.errorVotes++
    }

    await db.put('other', generalStats, 'generalStats')
    await db.put('other', todayStats, 'todayStats')
    await updateValue('projects', project)

    console.log('clearing next attempt')

    async function removeQueue() {
        for (const [tab, value] of openedProjects) {
            if (tab.startsWith?.('queue_') && project.key === value.key) {
                openedProjects.delete(tab)
            }
        }
        db.put('other', openedProjects, 'openedProjects')
        checkVote()
    }

    setTimeout(() => {
        removeQueue()
    }, timeout)
}

async function openOptionsPage() {
}

function getProjectPrefix(project, detailed) {
    let text = ''
    if (project.nick && project.nick !== '') text += ' – ' + project.nick
    if (detailed && project.game && project.game !== '') text += ' – ' + project.game
    if (detailed) {
        if (project.id && project.id !== '') text += ' – ' + project.id
        if (project.name && project.name !== '') text += ' – ' + project.name
    } else {
        if (project.name && project.name !== '') {
            text += ' – ' + project.name
        } else if (project.id && project.id !== '') {
            text += ' – ' + project.id
        }
    }
    if (text === '') {
        return '[' + project.rating + ']'
    } else {
        text = text.replace(' – ', '')
        return '[' + project.rating + '] ' + text
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateValue(objStore, value) {
    const store = db.transaction(objStore, 'readwrite').store
    const found = await store.count(value.key)
    if (found) {
        await store.put(value, value.key);
        (async () => {
            try {
                await chrome.runtime.sendMessage({ updateValue: objStore, value })
            } catch (error) {
                if (!error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                    console.error(error.message)
                }
            }
        })();
    } else {
        console.warn('The ' + objStore + ' could not be found, it may have been deleted', JSON.stringify(value))
    }
}

let awaitingEid = false
async function refreshNow() {
    console.log('scheduling refresh')
    refreshSites(async () => {
        const store = db.transaction('other', 'readwrite').store
        settings = await store.get('settings')
        generalStats = await store.get('generalStats')
        todayStats = await store.get('todayStats')
        for (const [key, value] of openedProjects) {
            openedProjects.delete(key)
            tryCloseTab(key, value, 0)
        }
        await store.put(openedProjects, 'openedProjects')
        checkVote()
    }, async () => {
        awaitingEid = true
        chrome.tabs.create({ url: "https://purevanilla.co/vote", active: false });
    }).then(() => {
        console.log('refresh completed')
    }).catch(() => {
        console.log('error while refreshing')
    })
}
chrome.runtime.onInstalled.addListener(async function (details) {
    await initializeFunc
    // noinspection JSUnresolvedReference
    if (!settings.operaAttention2 && (navigator?.userAgentData?.brands?.[0]?.brand === 'Opera' || (!!self.opr && !!opr.addons) || !!self.opera || navigator.userAgent.indexOf(' OPR/') >= 0)) {
        chrome.runtime.openOptionsPage()
        return
    }
    if (details.reason === 'install') {
        await openOptionsPage()
        chrome.runtime.sendMessage({ installed: true })
    }
    await refreshNow()
})