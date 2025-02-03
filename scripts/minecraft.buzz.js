async function vote(first) {
    if (checkAnswer()) return
    if (!first) {
        document.querySelector('#submitter.btn-warning').click()
    } else {
        const project = await getProject()
        document.getElementById('review-check').checked = false
        document.getElementById('username-input').value = project.nick
        document.querySelector('#submitter.btn-primary').click()
        await new Promise(resolve => setTimeout(resolve, 16 * 1000));
    }

}

function checkAnswer() {
    if (document.getElementById('message')) {
        const request = {}
        request.message = document.getElementById('message').textContent.trim()
        if (request.message.includes('Thank you for voting')) {
            chrome.runtime.sendMessage({ successfully: true })
        } else if (request.message.includes('already voted')) {
            chrome.runtime.sendMessage({ later: true })
        } else {
            if (request.message.includes('proxy') || request.message.includes('Captcha') || request.message.includes('Username can\'t be empty')) {
                request.ignoreReport = true
            }
            chrome.runtime.sendMessage(request)
        }
        clearInterval(timer)
        return true
    }
}

const timer = setInterval(() => {
    try {
        checkAnswer()
    } catch (e) {
        clearInterval(timer)
        throwError(e)
    }
}, 1000)