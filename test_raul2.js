import fetch from 'node-fetch';

async function testRaul() {
    try {
        console.log("Fetching Raul Munoz...");
        const searchRes = await fetch('https://api.openalex.org/authors?search=Raul+Munoz');
        const searchData = await searchRes.json();
        const author = searchData.results[0];
        console.log("Found Author:", author.display_name, author.id, "works_count:", author.works_count);

        const cleanId = author.id.split('/').pop();
        let url = `https://api.openalex.org/works?filter=author.id:${cleanId}&sort=cited_by_count:desc&per-page=30&page=1`;
        
        console.log("Calling API:", url);
        const worksRes = await fetch(url);
        const data = await worksRes.json();
        console.log("Works retrieved:", data.results.length);
        if (data.results.length > 0) {
            console.log("First work:", data.results[0].title);
        } else {
            console.log("FAIL: 0 works retrieved!");
        }
    } catch (e) {
        console.error(e);
    }
}

testRaul();
