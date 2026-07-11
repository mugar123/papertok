import { getWorksByEntity } from './src/services/openAlexService.js';
import fetch from 'node-fetch';

global.fetch = fetch;

async function testRaul() {
    try {
        console.log("Fetching Raul Munoz...");
        // Usually resolvedId comes from getAuthorsByEntity. 
        // Let's first search for the author to get his ID
        const searchRes = await fetch('https://api.openalex.org/authors?search=Raul+Munoz');
        const searchData = await searchRes.json();
        const author = searchData.results[0];
        console.log("Found Author:", author.display_name, author.id, "works_count:", author.works_count);

        console.log("Calling getWorksByEntity...");
        const works = await getWorksByEntity('author', author.id);
        console.log("Works retrieved:", works.papers.length);
        if (works.papers.length > 0) {
            console.log("First work:", works.papers[0].title);
            console.log("Categories:", works.papers[0].categories);
            console.log("Has abstract:", !!works.papers[0].abstract);
        } else {
            console.log("FAIL: 0 works retrieved!");
        }
    } catch (e) {
        console.error(e);
    }
}

testRaul();
