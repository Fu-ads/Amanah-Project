var sessionChannel = new BroadcastChannel('sessionChannel');
var account = JSON.parse(localStorage.getItem('account'));
var sessionInterval;
var sessionExpiration;
function logout() {
    sessionExpiration = null;
    sessionChannel.postMessage({ 'logout': true })
    localStorage.removeItem('account')
    localStorage.removeItem('sessionExpiration')
    clearInterval(sessionInterval)
    sessionInterval = null
    account = null
}
async function sessionManagement() {
    let expiresIn = sessionExpiration - Date.now()
    if (10000 <= expiresIn && expiresIn <= 300000 && !isNaN(expiresIn)) {
        await navigator.locks.request('sessionToken', { ifAvailable: true }, async () => {
            try {
                let response = await fetch('/renewSession')
                response = await response.json()
                if (response['success']) {
                    sessionExpiration = new Date(response['expiresAt'])
                    sessionChannel.postMessage({ 'tokenRenewal': true, 'sessionExpiration': sessionExpiration })
                    localStorage.setItem('sessionExpiration', sessionExpiration.toISOString());
                } else if (45000 > expiresIn) logout()
            } catch (error) {
                console.log(`error connecting to the server\n${error}`)
                if (45000 > expiresIn) logout()
            }
            await new Promise(resolve => setTimeout(resolve, 30000));
        })
    } else if (45000 > expiresIn) logout()
}
if (account) {
    sessionExpiration = new Date(localStorage.getItem('sessionExpiration'))
    if ((sessionExpiration - Date.now()) < 0 || !sessionExpiration) {
        localStorage.removeItem('account')
        localStorage.removeItem('sessionExpiration')
        account = null
    } else
        sessionInterval = setInterval(sessionManagement, 30000)
}
sessionChannel.onmessage = (event) => {
    event = event['data']
    if (event['tokenRenewal'])
        sessionExpiration = event['sessionExpiration']
    else if (event['logout']) {
        console.log('logout')
        clearInterval(sessionInterval)
        sessionInterval = null
        account = null
    } else if (event['login']) {
        console.log(event)
        account = event['account']
        sessionExpiration = new Date(event['sessionExpiration'])
        if (!sessionInterval)
            sessionInterval = setInterval(sessionManagement, 30000)
    }
}