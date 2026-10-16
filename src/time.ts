import { getCalendars } from 'expo-localization';

// The device's own 12/24-hour setting; JS date formatting would ignore it.
const uses24HourClock = getCalendars()[0]?.uses24hourClock ?? true;

export function formatTime(at: number, withSeconds = false) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const minutes = withSeconds ? `${pad(date.getMinutes())}:${pad(date.getSeconds())}` : pad(date.getMinutes());
  if (uses24HourClock) return `${date.getHours()}:${minutes}`;
  return `${date.getHours() % 12 || 12}:${minutes} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}
