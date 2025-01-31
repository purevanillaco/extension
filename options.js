// noinspection ES6MissingAwait

const initializeFunc = initializeConfig()

let resolveLoad
const loaded = new Promise(resolve => resolveLoad = resolve)

let editingProject

//notifications

let Timer = function (callback, delay) {
    let timerId, start, remaining = delay

    this.pause = function () {
        clearTimeout(timerId)
        remaining -= Date.now() - start
    }

    this.resume = function () {
        start = Date.now()
        clearTimeout(timerId)
        timerId = setTimeout(callback, remaining)
    }

    this.getTimerId = function () {
        return timerId
    }

    this.resume()
}

window.addEventListener('load', async () => {
    await initializeFunc
    await reloadProjectList()
    resolveLoad()
    buildProject('https://mclike.com/vote-192575', null, "quiquelhappy")
})

//Добавить проект в список проекта
async function addProjectList(project, preBend) {
    if (!project.key) {
        if (project.priority) {
            preBend = true
            const store = db.transaction('projects', 'readwrite').store
            const cursor = await store.openCursor()
            if (!cursor || cursor.key === 1) {
                project.key = -1
            } else {
                project.key = cursor.key - 1
            }
            await store.put(project, project.key)
        } else {
            const store = db.transaction('projects', 'readwrite').store
            project.key = await store.put(project)
            await store.put(project, project.key)
        }
        usageSpace()

        if (project.time != null && project.time > Date.now()) {
            let create = true
            const alarms = await chrome.alarms.getAll()
            for (const alarm of alarms) {
                // noinspection JSUnresolvedVariable
                if (alarm.scheduledTime === project.time) {
                    create = false
                    break
                }
            }
            if (create) {
                chrome.alarms.create(String(project.key), { when: project.time })
            }
        } else {
            chrome.runtime.sendMessage('checkVote')
        }
    }

    await updateProjectText(project)
}

async function updateModalStats(project, toggle) {
    if (toggle) {
        toggleModal('stats')
        project = await db.get('projects', project.key)
    } else {
    }
    let text = project.rating
    if (project.nick && project.nick !== '') text += ' – ' + project.nick
    if (project.game && project.game !== '') text += ' – ' + project.game
    if (project.name && project.name !== '') {
        text += ' – ' + project.name
    } else if (project.id && project.id !== '') {
        text += ' – ' + project.id
    }
}

//Удалить проект из списка проекта
async function removeProjectList(project, editing, event) {
    if (!editing && editingProject?.key === project.key) resetEdit()
    return true
}

//Перезагрузка списка проектов
async function reloadProjectList() {
    const index = db.transaction('projects').store.index('rating')
    for (const item of Object.keys(allProjects)) {
        const count = await index.count(item)
        if (count > 0) {
            if (item === 'Custom') {
                if (!settings.enableCustom) addCustom()
            }
        }
    }
}

//Слушатель дополнительных настроек

function editProject(project, switchToEdit) {
    resetEdit()
    editingProject = project

    if (project.time > Date.now()) {
        const time = new Date(project.time)
        // noinspection JSCheckFunctionSignatures
        if (!isNaN(time)) {
            time.setMinutes(time.getMinutes() - time.getTimezoneOffset())
        }
    }
    if (project.timeout != null || project.timeoutHour != null || project.rating === 'Custom') {
        if (!project.timeout) {
            const hours = new Date(1980, 0, 1, project.timeoutHour, project.timeoutMinute, project.timeoutSecond, project.timeoutMS)
            hours.setMinutes(hours.getMinutes() - hours.getTimezoneOffset())
        }
    }
    let text = project.rating
    if (project.nick && project.nick !== '') text += ' – ' + project.nick
    if (project.game && project.game !== '') text += ' – ' + project.game
    if (project.name && project.name !== '') {
        text += ' – ' + project.name
    } else if (project.id && project.id !== '') {
        text += ' – ' + project.id
    }
}

//Слушатель кнопки "Добавить"

async function buildProject(url, lastVote, username) {
    try {
        domain = getDomainWithoutSubdomain(url)
        funcRating = allProjects[domain]
        if (!funcRating) {
            return
        }
        project = funcRating.parseURL(new URL(url))
        project.rating = domain

        if (funcRating.URLMain) {
            const domain2 = funcRating.URLMain?.()
            if (domain2 !== domain) {
                project.ratingMain = domain2
            }
        }

        if (!funcRating.notRequiredId?.() && (project.id == null || project.id === '')) {
            return
        }

        if (funcRating.exampleURLGame && project.game == null) {
            return
        }

        if (funcRating.exampleURLListing && project.listing == null) {
            return
        }

        if (funcRating.langList && project.lang == null) {
            return
        }
    } catch (error) {
        return
    }


    if (project.rating !== 'Custom' && !funcRating.notRequiredNick?.(project)) {
        project.nick = username
    }

    project.stats = {
        successVotes: 0,
        monthSuccessVotes: 0,
        lastMonthSuccessVotes: 0,
        errorVotes: 0,
        laterVotes: 0,
        lastSuccessVote: lastVote,
        lastAttemptVote: null,
        added: Date.now()
    }
    await addProject(project)
}

async function addProject(project, element) {

    // noinspection JSUnresolvedFunction
    let found = await db.countFromIndex('projects', 'rating, id', [project.rating, project.id])
    if (found > 0) {
        const message = chrome.i18n.getMessage('alreadyAdded')
        return
    }

    if (!await checkPermissions([project])) return


    await addProjectList(project)

    // noinspection JSUnresolvedVariable
    if (!settings.operaAttention && (navigator?.userAgentData?.brands?.[0]?.brand === 'Opera' || (!!window.opr && !!opr.addons) || !!window.opera || navigator.userAgent.indexOf(' OPR/') >= 0) && !(allProjects[project.rating].notRequiredCaptcha?.(project) || allProjects[project.rating].alertManualCaptcha?.())) {
        settings.operaAttention = true
        db.put('other', settings, 'settings')
    }

    if (allProjects[project.rating].alertManualCaptcha?.()) {
        alert(chrome.i18n.getMessage('alertCaptcha'))
    }
    if (allProjects[project.rating].focusedTab?.(project)) {
        alert(chrome.i18n.getMessage('alertFocusedTab'))
    }
}

async function checkPermissions(projects, element) {
    const origins = []
    const permissions = []
    for (const project of projects) {
        const funcProject = allProjects[project.rating]
        const url = funcProject.pageURL(project)
        const domain = getDomainWithoutSubdomain(url)
        if (!origins.includes('*://*.' + domain + '/*')) origins.push('*://*.' + domain + '/*')
        if (!funcProject.notRequiredCaptcha?.(project)) {
            // noinspection JSUnresolvedReference
            for (const origin of chrome.runtime.getManifest().host_permissions) {
                if (!origins.includes(origin)) origins.push(origin)
            }
        }
        if (funcProject.needAdditionalOrigins) {
            for (const origin of funcProject.needAdditionalOrigins(project)) {
                if (!origins.includes(origin)) origins.push(origin)
            }
        }
        if (funcProject.needAdditionalPermissions) {
            for (const permission of funcProject.needAdditionalPermissions(project)) {
                if (!permissions.includes(permission)) permissions.push(permission)
            }
        }
    }

    // noinspection JSUnresolvedFunction
    let granted = await chrome.permissions.contains({ origins, permissions })
    if (!granted) {
        if (element == null) {
            try {
                // noinspection JSVoidFunctionReturnValueUsed
                console.log('Request permissions', origins, permissions)
                granted = await chrome.permissions.request({ origins, permissions })
                if (!granted) {
                    return false
                } else {
                    return true
                }
            } catch (error) {
                if (!error.message.includes('must be called during a user gesture') && !error.message.includes('may only be called from a user input handler')) {
                    return false
                }
                console.log(error)
            }
        }
        const button = document.createElement('button')
        button.textContent = chrome.i18n.getMessage('grant')
        button.classList.add('submitBtn')
        try {
            granted = await chrome.permissions.request({ origins, permissions })
        } catch (error) {
            granted = false
        }
        if (!granted) {
            granted = false
        } else {
            granted = true
        }
        return granted
    }
    return true
}

usageSpace()
async function usageSpace() {
    const quota = await navigator.storage.estimate()
    // Код рассчитывающий использованное место позаимствовано из uBlock Origin https://github.com/gorhill/uBlock/blob/feaa338678ab64e334d33d5b5fb06749877454e7/src/js/settings.js#L118
    let v, unit
    v = quota.usage
    if (v < 1e3) {
        unit = 'genericBytes'
    } else if (v < 1e6) {
        v /= 1e3
        unit = 'KB'
    } else if (v < 1e9) {
        v /= 1e6
        unit = 'MB'
    } else {
        v /= 1e9
        unit = 'GB'
    }
}

function lagServiceWorker(event) {
    const button = document.createElement('button')
    button.classList.add('btn')
    button.id = 'restartBtn'
    button.addEventListener('click', () => {
        if (confirm(chrome.i18n.getMessage('confirmRestartExtension'))) {
            chrome.runtime.reload()
        }
    })
    button.textContent = chrome.i18n.getMessage('restartExtension')
    if (event.target) event.target.disabled = false
    if (event.submitter) event.submitter.disabled = false
}

chrome.runtime.onMessage.addListener(onMessage)

async function onMessage(request) {
    if (request.installed) {
        window.history.replaceState(null, null, 'options.html')
    }
}