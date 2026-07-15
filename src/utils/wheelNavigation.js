export const WHEEL_NAVIGATION_THRESHOLD = 110;
export const PIXEL_DELTA_MODE = 0;
export const TRACKPAD_MOMENTUM_THRESHOLD = 80;

export function shouldUseNativeWheelScroll(deltaMode) {
  return deltaMode === PIXEL_DELTA_MODE;
}

export function shouldClampTrackpadMomentum(deltaY, threshold = TRACKPAD_MOMENTUM_THRESHOLD) {
  return Math.abs(deltaY) >= threshold;
}

export function accumulateWheelGesture(currentDelta, nextDelta, threshold = WHEEL_NAVIGATION_THRESHOLD) {
  const continuingGesture = currentDelta === 0 || Math.sign(currentDelta) === Math.sign(nextDelta);
  const accumulatedDelta = (continuingGesture ? currentDelta : 0) + nextDelta;

  if (Math.abs(accumulatedDelta) < threshold) {
    return { accumulatedDelta, direction: 0 };
  }

  return { accumulatedDelta: 0, direction: accumulatedDelta > 0 ? 1 : -1 };
}
