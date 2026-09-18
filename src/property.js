// Zostel Mumbai property knowledge — single source for message copy and
// (later) reactive AI Q&A. Never dump all of this into one message.
export const PROPERTY = {
  name: 'Zostel Mumbai',
  area: 'Andheri East',
  address:
    'Zostel Mumbai, Karotra Niwas School, off Military Road, near Prime Academy, Bhavani Nagar, Marol, Andheri East, Mumbai, Maharashtra 400059',
  shortAddress: 'Andheri East, Mumbai',
  checkInTime: '1:00 PM',
  checkOutTime: '10:00 AM',
  highlights: [
    'a cafe for remote-work days',
    'a common area full of games',
    'a Bollywood-themed rooftop',
    'movie nights',
    'pub crawls with the hostel gang',
  ],
  experiences: [
    'an evening walk at Marine Drive',
    'the Gateway of India',
    'Mumbai street food hunting',
    'the Elephanta Caves',
    'a Bandstand sunset',
  ],
  rules: {
    age: '18+ only',
    groupSize: 'max 4 per group',
    alcohol: 'allowed only in the common area',
    outsiders: 'allowed only in the cafe',
    food: 'in-house cafe',
    notSuitable: 'not suitable for corporates',
  },
};

export function istHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(date)
  );
}
