// Lead Check (SPEC steps 26–27): the problems' names for filters, as the server says them.

export const CHECK_CODES: [string, string][] = [
  ["ADDRESS_HAS_PHONE", "Address holds a phone number"],
  ["ADDRESS_HAS_EMAIL", "Address holds an email"],
  ["ADDRESS_HAS_LINK", "Address holds a link"],
  ["WEBSITE_IS_FACEBOOK", "Website is a Facebook link"],
  ["WEBSITE_IS_INSTAGRAM", "Website is an Instagram link"],
  ["WEBSITE_IS_GOOGLE", "Website is a Google Maps link"],
  ["WEBSITE_NOT_LINK", "Website isn't a link"],
  ["PHONE_HAS_LETTERS", "Phone holds letters"],
  ["PHONE_WRONG_LENGTH", "Phone isn't a 10-digit US number"],
  ["WHATSAPP_NOT_PHONE", "WhatsApp isn't a phone number"],
  ["GBP_NOT_MAPS", "GBP link isn't a Google Maps link"],
  ["NAME_IS_LINK", "Business name is a link"],
  ["NAME_IS_PHONE", "Business name is a phone number"],
  ["CITY_HAS_NUMBERS", "City holds numbers"],
  ["FACEBOOK_IS_INSTAGRAM", "Facebook is an Instagram link"],
  ["FACEBOOK_NOT_FACEBOOK", "Facebook isn't a Facebook link"],
  ["INSTAGRAM_IS_FACEBOOK", "Instagram is a Facebook link"],
  ["INSTAGRAM_NOT_INSTAGRAM", "Instagram isn't an Instagram link"],
  ["REVIEWS_NOT_NUMBER", "Reviews isn't a whole number"],
  ["RATING_NOT_NUMBER", "Rating isn't a number"],
  ["RATING_OUT_OF_RANGE", "Rating isn't between 0 and 5"],
  ["REVIEWS_RATING_SWAPPED", "Reviews and Rating look swapped"],
  ["NO_GBP_LINK", "No GBP link (warning)"],
  ["NO_PHONE", "No phone (warning)"],
  ["NO_ADDRESS", "No address (warning)"],
  ["ADDRESS_OTHER_CITY", "Address doesn't mention the city (warning)"],
  ["EMAIL_PLACEHOLDER", "Email looks made up (warning)"],
  ["NAME_TOO_LONG", "Business name unusually long (warning)"],
];

export const FIELD_NAMES: Record<string, string> = {
  business_name: "Business name",
  gbp_link: "GBP link",
  address: "Address",
  city: "City",
  website: "Website",
  phone: "Phone",
  whatsapp: "WhatsApp",
  email: "Email",
  facebook: "Facebook",
  instagram: "Instagram",
  reviews: "Reviews",
  rating: "Rating",
  notes: "Notes",
};

/** "🔴 2 · 🟠 1", or "" when there is nothing wrong. */
export function problemCount(errors: number, warnings: number): string {
  const parts = [];
  if (errors) parts.push(`🔴 ${errors}`);
  if (warnings) parts.push(`🟠 ${warnings}`);
  return parts.join(" · ");
}
