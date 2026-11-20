import { useContext } from 'react';
import { CustomFeedsContext, type CustomFeedsValue } from '../context/custom-feeds-context.ts';

export function useCustomFeeds(): CustomFeedsValue {
  const context = useContext(CustomFeedsContext);
  if (!context) throw new Error('useCustomFeeds must be used within a CustomFeedsProvider');
  return context;
}
