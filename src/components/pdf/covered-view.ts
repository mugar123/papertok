/** Whether a covered view's surfaces can be skipped (pdf-viewer.css); where not, they are made inert. */
export const skipsCoveredView = typeof CSS !== 'undefined' && CSS.supports('content-visibility', 'hidden');
