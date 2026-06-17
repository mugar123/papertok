import https from 'https';
https.get('https://api.openaire.eu/search/publications?format=json&size=1', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const parsed = JSON.parse(data);
        console.log(Object.keys(parsed.response));
    });
});
