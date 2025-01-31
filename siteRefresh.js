async function refreshSites(callback) {
    console.log('refreshSites')
    let next = 3600 * 1000 * 2
    try {
        let cursor = await db.transaction('projects', 'readwrite').store.index('rating').openCursor()
        while (cursor) {
            await cursor.delete()
            chrome.alarms.clear(String(cursor.primaryKey))
            cursor = await cursor.continue()
        }
        const req = await fetch('https://api.beta.serverbench.io/community/hn2qqSZ30ebQWWd_7uso9/listing/display', {
            headers: {
                'Content-Type': 'application/json',
                'username': 'quiquelhappy'
            },
            method: 'POST',
            body: JSON.stringify({
                username: 'quiquelhappy'
            })
        })
        const data = await req.json()
        for (const siteDisplay of data.sites) {
            if (siteDisplay.secondary) continue;
            await buildProject(
                siteDisplay.site.url,
                siteDisplay.last ? new Date(siteDisplay.last) : null,
                siteDisplay.next ? new Date(siteDisplay.next) : null,
                data.member.name
            )
        }
        if (data.primaryNext) {
            const nextVote = new Date(data.primaryNext).getTime() - Date.now()
            if (nextVote > 0 && nextVote < next) {
                next = nextVote
            }
        }
        await callback()
    } catch (error) {
        console.error(error)
        next = 1000 * 60 * 5
    }
    setTimeout(refreshSites, next)
}


async function buildProject(url, lastVote, nextVote, username) {
    console.log('buildProject', url, lastVote, nextVote, username)
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
    if (nextVote) {
        project.time = newVote.getTime()
    }
    await addProject(project)
}

async function addProject(project, element) {
    let found = await db.countFromIndex('projects', 'rating, id', [project.rating, project.id])
    if (found > 0) {
        return
    }

    await addProjectList(project)
}


async function addProjectList(project, preBend) {
    if (!project.key) {
        const store = await db.transaction('projects', 'readwrite').store
        project.key = await store.put(project)
        await store.put(project, project.key)

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
                await chrome.alarms.create(String(project.key), { when: project.time })
            }
        }
    }
}