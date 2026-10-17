export function getDeviceInfo() {
  const ua = navigator.userAgent;
  let type = 'desktop';
  if (/Mobi|Android|iPhone/i.test(ua)) {
    type = 'mobile';
  } else if (/Tablet|iPad/i.test(ua)) {
    type = 'tablet';
  }
  return {
    type,
    userAgent: ua,
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
  };
}
