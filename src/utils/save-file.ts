/** Saves `file` through the browser's download, named after `title` with characters file systems refuse replaced. */
export function saveFile(file: Blob, title: string, extension: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(title || 'paper').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120)}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
