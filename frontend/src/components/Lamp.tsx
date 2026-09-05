/** Small status lamp: green live (pulsing), red alert, gray idle. */
export function Lamp({ on, alert }: { on: boolean; alert?: boolean }) {
  const color = alert ? "bg-alert" : on ? "bg-ok" : "bg-line";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color} ${on && !alert ? "lamp-live" : ""}`} />;
}
