async function signupEvent(e) {
    e.preventDefault();
    let [x, y, accountID, verificationLink] = window.location.pathname.split('/')
    let data = `username=${document.getElementById('username').value}&password=${document.getElementById('password').value}&accountID=${accountID}&verificationLink=${verificationLink}`
    let response = await fetch(this.action, {
        method: this.method,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: data
    })
    response = await response.json()
    if (response['reason'])
        document.getElementById('formResult').innerHTML = response['reason']
    if (response['success']) {
        sessionInterval = setInterval(sessionManagement, 30000)
        localStorage.setItem('sessionExpiration', new Date(response['expiresAt']).toISOString())
        localStorage.setItem('account', JSON.stringify(response['account']))
        account = response['account']
        sessionExpiration = new Date(response['expiresAt'])
        sessionChannel.postMessage({ 'login': true, 'sessionExpiration': response['expiresAt'], 'account': response['account']})
    }
}
document.getElementById('signupForm').addEventListener('submit', signupEvent)