const contents = "data:application/atom+xml; charset=utf-8;base64,PD94bWwgdmVyc2lvbj0nMS4wJyBlbmNvZGluZz0nVVRGLTgnPz4K";
let xmlText = contents;
if (contents.startsWith('data:')) {
  const base64Data = contents.split(',')[1];
  xmlText = atob(base64Data);
}
console.log('Decoded:', xmlText);
