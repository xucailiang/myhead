import { useEffect, useRef } from 'react';
import type { MyHeadSseEvent } from '@myhead/contracts';

export function useSse(
  url: string | null,
  onEvent: (event: MyHeadSseEvent) => void,
) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!url) return;

    const source = new EventSource(url);
    let stopped = false;

    source.onmessage = (e) => {
      if (stopped) return;
      try {
        const parsed = JSON.parse(e.data) as MyHeadSseEvent;
        onEventRef.current(parsed);
      } catch {
        // skip parse errors
      }
    };

    source.onerror = () => {
      if (!stopped) {
        source.close();
      }
    };

    return () => {
      stopped = true;
      source.close();
    };
  }, [url]);
}
