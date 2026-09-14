function search(element, list, borderRadius) {
    let query = element.value
    let results = ''
    let resultElement = element.nextElementSibling
    let parentElement = element.offsetParent
    list.forEach(value => {
        if (value.toLowerCase().includes(query.toLowerCase()))
            results += `<a href='/coin/${value}' id='result'>${value}</a>`
    })
    if (results !== '' && query !== '') {
        parentElement.style.borderBottomLeftRadius = 0;
        parentElement.style.borderBottomRightRadius = 0;
        resultElement.style.visibility = 'visible';
        resultElement.innerHTML = results
    } else {
        parentElement.style.borderBottomLeftRadius = borderRadius;
        parentElement.style.borderBottomRightRadius = borderRadius;
        resultElement.style.visibility = 'hidden';
    }
}
function searchValidation(inputElement, list) {
    let query = document.getElementById(inputElement).value
    let valid = false
    list.forEach(value => {
        if(value.toLowerCase() == query.toLowerCase())
            valid = true
    })
    return valid
}