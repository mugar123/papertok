import { getPapersByProject } from './src/services/openAireService.js';
getPapersByProject('101079773', 1).then(console.log).catch(console.error);
