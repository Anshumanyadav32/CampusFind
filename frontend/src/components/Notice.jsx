import { useEffect } from "react";

export default function Notice({ notice, noticeType, setNotice, autoDismissMs }) {
  useEffect(() => {
    if (!notice || !autoDismissMs) return undefined;

    const timer = window.setTimeout(() => setNotice(""), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, notice, setNotice]);

  if (!notice) return null;

  return (
    <div className={`notice ${noticeType}`} role="status">
      <span>{noticeType === "success" ? "✓" : "!"}</span>
      {notice}
      <button onClick={() => setNotice("")} aria-label="Dismiss message">
        ×
      </button>
    </div>
  );
}
