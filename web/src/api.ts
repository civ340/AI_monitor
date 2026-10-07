/** 後端 REST 的薄包裝。所有失敗都轉成 Error，呼叫端自己決定怎麼顯示「讀不到」 */

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type OpenTarget = "folder" | "editor";

/**
 * 叫後端在本機開資料夾／VS Code。要帶自訂 header 才會被後端接受（擋跨站請求）。
 * 失敗時丟出帶中文訊息的 Error：501 = 這台沒有 VS Code。
 */
export async function openTarget(id: string, target: OpenTarget): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Monitor": "1" },
      body: JSON.stringify({ id, target }),
    });
  } catch {
    throw new Error("連不上後端");
  }
  if (res.ok) return;
  if (res.status === 501) throw new Error("找不到 VS Code（請確認 code 指令已加入 PATH）");
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = body.error;
  } catch {
    // 回應不是 JSON 就只報狀態碼
  }
  throw new Error(detail ? `開啟失敗：${detail}` : `開啟失敗（HTTP ${res.status}）`);
}
