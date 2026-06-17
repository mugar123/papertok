import { fetchPapersByDois } from './src/services/openAlexService.js';
fetchPapersByDois([
    '10.3390/condmat10020025',
    '10.3390/ijms25052546',
    '10.1016/j.sab.2025.107203'
]).then(res => console.log(res.length, "papers fetched")).catch(console.error);
