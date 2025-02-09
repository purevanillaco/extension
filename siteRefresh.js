async function refreshSites(callback, retrieveEid) {
    const transaction = await pvDb.transaction("user", "readonly");
    const store = await transaction.objectStore("user");
    const eid = (await store.get('eid'))?.value
    if (eid == null) {
        await retrieveEid()
        return
    }

    console.log('refreshSites', eid)
    let next = 1000 * 3600
    try {
        const req = await fetch('https://api.beta.serverbench.io/community/hn2qqSZ30ebQWWd_7uso9/listing/display', {
            headers: {
                'Content-Type': 'application/json',
            },
            method: 'POST',
            body: JSON.stringify({
                eid
            })
        })
        const data = await req.json()
        const futureJobs = []
        for (const siteDisplay of data.sites) {
            if (siteDisplay.secondary && data.primaryCompleted == null) continue;
            const nextVote = siteDisplay.next ? new Date(siteDisplay.next) : null
            if (nextVote) {
                // retry voting on future-expiring vote
                const relative = nextVote - Date.now()
                if (relative > 0 && relative < next) {
                    next = relative
                }
            }
            const domain = siteDisplay.site.site.domain
            if (domain == null) {
                console.log('domain is null', siteDisplay.site.url)
                continue
            }
            if (allProjects[domain.toLowerCase()] == null) {
                console.log('no parser for', domain)
                continue
            }
            if (nextVote && nextVote.getTime() > Date.now()) {
                console.log('already voted skipping', siteDisplay.site.url, nextVote)
                continue;
            }
            futureJobs.push(buildProject(
                siteDisplay.site.url,
                siteDisplay.last ? new Date(siteDisplay.last) : null,
                nextVote,
                data.member.name
            ))
        }
        // delete all existing data, it will be refreshed now
        let cursor = await db.transaction('projects', 'readwrite').store.index('rating').openCursor()
        while (cursor) {
            await cursor.delete()
            cursor = await cursor.continue()
        }
        console.log('deleted all')
        console.log('pending jobs: ' + futureJobs.length)
        if (futureJobs.length > 0) {
            await Promise.all(futureJobs)
            console.log('voting in background...')
            callback().then(() => {
                console.log('finished scheduled job')
            }).catch((err) => {
                console.error('error on scheduled job', err)
            })
        }
        if (data.primaryNext) {
            // if next primaries are sooner, refresh on that
            const nextVote = new Date(data.primaryNext).getTime() - Date.now()
            if (nextVote > 0 && nextVote < next) {
                next = nextVote
            }
        }
    } catch (error) {
        // retry after 5 minutes on error
        console.log("early refresh due to error", error)
        next = 1000 * 60 * 5
    }
    console.log('next refresh: ', new Date(Date.now() + next))
    chrome.alarms.create("siteRefresh", { delayInMinutes: Math.max(Math.trunc(next / (60 * 1000)), 1) });
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
        project.time = nextVote.getTime()
    }
    await addProject(project)
}

async function addProject(project, element) {
    let found = await db.countFromIndex('projects', 'rating, id', [project.rating, project.id])
    if (found > 0) {
        await db.delete('projects', project.id);
    }

    await addProjectList(project)
}


async function addProjectList(project, preBend) {
    if (!project.key) {
        const store = await db.transaction('projects', 'readwrite').store
        project.key = await store.put(project)
        await store.put(project, project.key)
    }
}