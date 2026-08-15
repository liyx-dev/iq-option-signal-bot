export function nextMinute(tsMs=Date.now(), leadMinutes=2) {
  const d=new Date(tsMs);
  d.setSeconds(0,0);
  d.setMinutes(d.getMinutes()+leadMinutes);
  return d.getTime();
}

export function entryAndExpiry(leadMinutes, expiryMinutes, now=Date.now()) {
  const entry=nextMinute(now,leadMinutes);
  return {entryMs:entry,expiryMs:entry+expiryMinutes*60000};
}

export function formatWAT(tsMs) {
  return new Date(tsMs).toLocaleTimeString("en-US",{
    timeZone:"Africa/Lagos",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true
  });
}
