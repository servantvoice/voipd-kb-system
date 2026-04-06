export type UrlCategory = "public" | "internal" | "excluded";

// ─── EXCLUDED ──────────────────────────────────────────────────────────────

export const EXCLUDE_PREFIXES = [
  "/dg-branding/",
  "/dg-invoicing/",
  "/dg-products/",
  "/dg-customers/",
  "/dg-usage/",
  "/dg-taxes-and-fees/",
  "/datagate/",
  "/billing-administration/",
  "/rays-stuff/",
  "/devops-automation-engineer",
  "/mfax-events/",
  "/snaphd/",
  "/creating-a-snapacademy-user",
  "/onboarding-recommendations/1926749-getting-started-with-managed-compliance",
];

// ─── INTERNAL ──────────────────────────────────────────────────────────────

export const INTERNAL_PREFIXES = [
  "/announcements/",
  "/carrier-events/",
  "/platform-events/",
  "/release-notes/",
  "/manager-portal-pro-releases/",
  "/onboarding-recommendations/",
  "/voipmonitor/",
  "/ob-branding/",
  "/ob-invoicing/",
  "/ob-products/",
  "/ob-customers/",
  "/ob-usage/",
  "/ob-taxes-and-fees/",
  "/onebill/",
  "/branding/",
  "/cloudie_connect/",
  "/cloudieconnect-desktop/",
  "/cloudieconnect/",
  "/desktop-applications/",
  "/fanvil/",
  "/grandstream/",
  "/polycom/",
  "/snom/",
  "/wildix/",
  "/inventory-phone-numbers/",
  "/local-toll-free-porting/",
  "/mfax-analog/",
  "/mfax-digital/",
  "/mobile-applications/",
  "/mobile-x/",
  "/sip-trunking/",
  "/teammate-connector/",
  "/training-courses/",
  "/troubleshooting/",
  "/uc-integrator/",
  "/integrations/",
];

export const INTERNAL_EXACT_PATHS = [
  "/faqs/contacts-and-hours-of-operation",
  "/faqs/hardware-return-policy",
  "/faqs/partner-cheat-sheet",
  "/faqs/partner-central-complete-a-quote-request-form",
  "/faqs/oitvoip-merch-requests",
  "/features/enable-sso-for-a-domain",
  "/hardware-software/configure-custom-overrides-for-a-domain",
  "/hardware-software/how-to-get-access-to-yealink-mcs-or-dms",
  "/hardware-software/packaging-guidelines",
  "/hardware-software/unifi-talk-sip-trunk-setup",
  "/hardware-software/upgrade-firmware-on-avaya-j100-series",
  "/hosted-voice/1925587-untitled-article",
  "/hosted-voice/create-a-domain",
  "/hosted-voice/delete-a-domain",
  "/hosted-voice/dns-records",
  "/hosted-voice/move-domains-across-resellers",
  "/how-to-move-a-mobile-x-esim-to-a-new-phone-",
  "/native-fax-major-incident-timeline-071924",
  "/snapmobile/how-to-complete-the-branded-snapmobile-android-google-declaration",
  "/voicemail/enable-voicemail-transcription",
  "/yealink/yealink-management-cloud-service-ymcs-remote-provisioning-service-rps",
  "/2024-02-02-summary-of-outage-resolved",
  "/2024-03-02-las-core-dump-resolved",
  "/2024-06-24-native-fax-outbound-faxing-failure-resolved",
  "/diy-headshot-pictorial-guide-iphone-android",
  "/hipaa-compliance",
  "/call-routing/telnyx-add-a-technical-prefix-for-outbound-call-authentication",
  "/native-fax/add-native-fax-account",
  "/native-fax/delete-a-native-fax-account",
  "/native-fax/addremove-an-ata-from-a-user",
  "/native-fax/native-fax-send-a-fax-from-email",
  "/native-fax/native-fax-send-a-fax-from-email-oitvoip",
  "/e-911/remove-e911-number-from-manager-portal",
  "/e-911/register-e911-from-manager-portal",
  "/e-911/configure-notifications-for-e911-calling",
  "/auto-attendants/modify-timeouts-for-auto-attendants",
  "/yealink/yealink-overrides",
  "/features/retrieve-sso-client-id",
  "/users/configure-speed-dials-sorting-list",
  "/conferencing/configure-an-audio-conference-bridge",
  "/hardware-software/enable-sip-signalling-over-tls",
  "/users/create-a-user",
  "/hardware-software/snapmobile-web-troubleshooting-registration-issue",
  "/hardware-software/mac-address-already-exists-in-the-manager-portal",
  "/billing-administration/taxes-and-fees",
];

export const PUBLIC_OVERRIDES = [
  "/integrations/url-call-popup",
];

export function categorizeUrl(urlPath: string): UrlCategory {
  const normalized = urlPath.replace(/^\/en_US/, "").toLowerCase();

  for (const override of PUBLIC_OVERRIDES) {
    if (normalized === override || normalized.startsWith(override + "/")) {
      return "public";
    }
  }

  for (const prefix of EXCLUDE_PREFIXES) {
    if (normalized.includes(prefix)) return "excluded";
  }

  for (const exactPath of INTERNAL_EXACT_PATHS) {
    if (normalized === exactPath || normalized === exactPath + "/") {
      return "internal";
    }
  }

  for (const prefix of INTERNAL_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(prefix)) {
      return "internal";
    }
  }

  if (/\/snapmobile\/.*-release-notes/.test(normalized)) return "internal";
  if (normalized.includes("partner")) return "internal";

  return "public";
}

export function urlToPath(fullUrl: string): string {
  return fullUrl
    .replace(/^https?:\/\/voipdocs\.io\/?/, "")
    .replace(/^en_US\//, "")
    .replace(/\/$/, "")
    || "index";
}
