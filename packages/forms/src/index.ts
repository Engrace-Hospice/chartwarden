// @wardenx/forms — Module 22 Pillar 2: form rendering (the §25.14 adapter-mandate boundary).
//
// This is the ONLY place a PDF render engine (react-pdf / Puppeteer) and a physical-mail print-vendor SDK
// may live; dependency-cruiser forbids any other module from importing them. The M22 backend consumes ONLY
// the contracts re-exported here.
//
// M22-T01 landed the §3.1 / §4.5 `FormTemplate` render contract + the §3.1 `PrintVendorAdapter` contract
// (the layout). The 31 v1 platform-floor templates, the react-pdf / Puppeteer adapters, the deny-stub +
// Lob / PostalMethods print vendors, the overlay-composer (D14/D16), and the golden-output test suite land
// in M22-T03/T04.
export * from "./templates/interface";
export * from "./adapters/print-vendors/interface";
