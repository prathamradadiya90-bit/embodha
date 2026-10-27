/**
 * India's states and union territories with their GST codes, in alphabetical order. Members in India pick one, and
 * it decides whether a website invoice carries CGST and SGST or IGST. The API checks the code against its own list.
 */
export const INDIAN_STATES: readonly (readonly [code: string, name: string])[] = [
  ['35', 'Andaman and Nicobar Islands'],
  ['37', 'Andhra Pradesh'],
  ['12', 'Arunachal Pradesh'],
  ['18', 'Assam'],
  ['10', 'Bihar'],
  ['04', 'Chandigarh'],
  ['22', 'Chhattisgarh'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['07', 'Delhi'],
  ['30', 'Goa'],
  ['24', 'Gujarat'],
  ['06', 'Haryana'],
  ['02', 'Himachal Pradesh'],
  ['01', 'Jammu and Kashmir'],
  ['20', 'Jharkhand'],
  ['29', 'Karnataka'],
  ['32', 'Kerala'],
  ['38', 'Ladakh'],
  ['31', 'Lakshadweep'],
  ['23', 'Madhya Pradesh'],
  ['27', 'Maharashtra'],
  ['14', 'Manipur'],
  ['17', 'Meghalaya'],
  ['15', 'Mizoram'],
  ['13', 'Nagaland'],
  ['21', 'Odisha'],
  ['34', 'Puducherry'],
  ['03', 'Punjab'],
  ['08', 'Rajasthan'],
  ['11', 'Sikkim'],
  ['33', 'Tamil Nadu'],
  ['36', 'Telangana'],
  ['16', 'Tripura'],
  ['09', 'Uttar Pradesh'],
  ['05', 'Uttarakhand'],
  ['19', 'West Bengal'],
];

export const stateName = (code: string | null | undefined) => INDIAN_STATES.find(([c]) => c === code)?.[1] ?? null;

/** States whose name has a word starting with what's typed: "ut" finds Uttar Pradesh and Uttarakhand, "pra" five. */
export function matchStates(typed: string, limit = 8) {
  const query = typed.trim().toLowerCase();
  if (!query) return [];
  return INDIAN_STATES.filter(([, name]) => name.toLowerCase().split(/\s+/).some((word) => word.startsWith(query)) || name.toLowerCase().startsWith(query)).slice(0, limit);
}
