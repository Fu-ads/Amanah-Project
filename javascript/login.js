async function loginEvent(e) {
    e.preventDefault();
    let data = `username=${document.getElementById('loginUsername').value}&password=${document.getElementById('loginPassword').value}`
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
        window.location.pathname = '/'
    }
}
document.getElementById('loginForm').addEventListener('submit', loginEvent)
document.getElementById('forgotPassword').addEventListener('click', async function (e) {
    e.preventDefault();
    document.getElementById('loginForm').removeEventListener('submit', loginEvent);
    let element = document.getElementById('forgotPassword');
    let response = await fetch('/resetPassword');
    response = await response.text();
    let form = element.closest('form')
    form.action = '/resetPassword';
    form.id = 'resetForm';
    form.innerHTML = response;
    document.getElementById('resetForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        let data = `username=${document.getElementById('resetUsername').value}`
        let response = await fetch(this.action, {
            method: this.method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: data
        })
        let resultElement = document.getElementById('formResult')
        resultElement.innerHTML = 'You will get an email with a reset link!'
    })
})