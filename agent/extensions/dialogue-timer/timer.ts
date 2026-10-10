/** m:ss; minutes keep increasing beyond one hour. Whole seconds are rounded down. */
export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
