// Zostel Morjim property knowledge — single source for message copy and
// (later) reactive AI Q&A. Never dump all of this into one message.
export const PROPERTY = {
  name: 'Zostel Morjim',
  area: 'Morjim, North Goa',
  address:
    'Pushkin House, 1088/1, Near Nanu Wines, Madhlowaddo, Morjim, Pernem, North Goa, Goa',
  shortAddress: 'Morjim, Goa',
  checkInTime: '1:00 PM',
  checkOutTime: '10:00 AM',
  highlights: [
    'steps from Morjim Beach',
    'a cafe for slow mornings and remote-work days',
    'a common area full of games',
    'beach sunsets with the hostel gang',
    'a social backpacker crowd',
  ],
  experiences: [
    'a sunset at Morjim Beach',
    'Chapora Fort views',
    'spotting Olive Ridley turtles (in season)',
    'the Ashwem–Mandrem beach stretch',
    'kayaking on the Chapora river',
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
