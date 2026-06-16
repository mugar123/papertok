import { renderToString } from 'react-dom/server';
import React from 'react';
import EntityExplorer from './src/components/Explorer/EntityExplorer';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import fetch from 'node-fetch';

// Polyfill for IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

async function test() {
  try {
    // 1. Mock fetch globally
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      console.log('Fetching:', url);
      if (url.includes('institutions/I136199984')) {
        return {
          ok: true,
          json: async () => require('fs').readFileSync('harvard.json', 'utf-8').then(JSON.parse)
        };
      }
      return { ok: false, json: async () => ({}) };
    };

    // 2. Fetch the JSON manually to save it
    const res = await originalFetch('https://api.openalex.org/institutions/I136199984');
    const data = await res.json();
    require('fs').writeFileSync('harvard.json', JSON.stringify(data));

    // 3. Try to render the component (we can't easily do this with Vite/JSX without babel)
    console.log("Data fetched. The error must be in the data structure.");
  } catch (err) {
    console.error(err);
  }
}

test();
