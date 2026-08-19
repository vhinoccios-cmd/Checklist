// Mega Campaign Checklist — sourced from Mega_Campaign_Checklist.xlsx
const CHECKLIST_SECTIONS = [
  {
    id: 'sku_inventory',
    title: 'SKU and Inventory',
    items: [
      { id: 'sku_01', name: 'Synagie Single SKU Upload (OMS 2.0, Anchanto)', guide: 'Are the campaign single SKUs already created in Synagie / Anchanto?' },
      { id: 'sku_02', name: 'Synagie Single SKU — OMS/Anchanto Check', guide: 'Are the campaign single SKUs checked in OMS 2.0 / Anchanto? (confirm created to avoid abnormal products)' },
      { id: 'sku_03', name: 'Synagie Kit Code Upload (OMS 2.0, Anchanto)', guide: 'Are the campaign kit codes already created in Synagie / Anchanto?' },
      { id: 'sku_04', name: 'Synagie Kit Components Check', guide: 'Are the campaign kit components checked in OMS 2.0 / Anchanto? (correct child SKU, quantity)' },
      { id: 'sku_05', name: 'Platform SKU Upload — Singles (Pre-sale, Bundles/Sets)', guide: 'Are the campaign single SKUs already created/updated in Seller Center? (Lazada, Shopee, Zalora, etc.)' },
      { id: 'sku_06', name: 'Platform Single SKU Price Check', guide: 'Are the campaign single SKU codes checked in the platform with the correct price?' },
      { id: 'sku_07', name: 'Platform Kit Code Upload', guide: 'Are the campaign kit codes already created/updated in Seller Center? (Lazada, Shopee, Zalora, etc.)' },
      { id: 'sku_08', name: 'Platform Kit Code Price Check', guide: 'Are the campaign kit codes checked in the platform with the correct price?' },
      { id: 'sku_09', name: 'Kit Listing Detail Check', guide: 'Have we checked that the kit details indicated in the listing are correct? (Name vs PDP vs Highlight vs Lorikeet)' },
      { id: 'sku_10', name: 'Hard Bundle Tracker', guide: 'Have we completed the Hard Bundle Tracker for Pre-Sale / Surprise Boxes?' },
      { id: 'sku_11', name: 'Hard Bundle — Single SKU Code', guide: 'Is the single SKU code used and updated in the platform?' },
      { id: 'sku_12', name: 'Manual Inventory Allocation', guide: 'Is the inventory already manually allocated?' },
    ]
  },
  {
    id: 'creative_brief',
    title: 'Creative Brief',
    items: [
      { id: 'cb_01', name: 'Creative Brief Submission', guide: 'Have we submitted the creative brief to the CAD team? (teasing, D-Day)' },
    ]
  },
  {
    id: 'sis_teasing',
    title: 'Store-in-Store Merchandising — Teasing',
    items: [
      { id: 'st_01', name: 'Mega Campaign Page — Teasing Assets Uploaded', guide: 'Are the Teasing assets uploaded?' },
      { id: 'st_02', name: 'Mega Campaign Page — Teasing Display Check', guide: 'Are the Teasing assets showing up properly in desktop, iOS, and Android?' },
      { id: 'st_03', name: 'Mega Campaign Page — Product Modules', guide: 'Do product modules display adequate product suggestions? (e.g. Slider Product Recommendation, Tab Switchable Products, etc.)' },
      { id: 'st_04', name: 'Mega Campaign Page — Banner Clickability', guide: 'Check if all banners are clickable and redirect to the correct page.' },
      { id: 'st_05', name: 'Mega Campaign Page — PB vs SiS Comparison', guide: 'Compare PB to SiS (GWP, price, texts, thumbnails)' },
      { id: 'st_06', name: 'Main Landing Page — Teasing Assets Uploaded', guide: 'Are the Teasing assets uploaded?' },
      { id: 'st_07', name: 'Main Landing Page — Links to Customized Pages', guide: 'Are the Teasing assets properly linked to the correct customized pages?' },
      { id: 'st_08', name: 'Main Landing Page — Product Modules', guide: 'Do product modules display adequate product suggestions? (e.g. Slider Product Recommendation, Tab Switchable Products, etc.)' },
      { id: 'st_09', name: 'Main Landing Page — Display Check', guide: 'Are the Teasing assets showing up properly in desktop, iOS, and Android?' },
      { id: 'st_10', name: 'Main Landing Page — PB vs SiS Comparison', guide: 'Compare PB to SiS (GWP, price, texts, thumbnails)' },
      { id: 'st_11', name: 'Customized Pages — Assets Uploaded', guide: 'Are the customized assets uploaded?' },
      { id: 'st_12', name: 'Customized Pages — Linked from SiS', guide: 'Is the customized page linked from the proper SiS asset?' },
      { id: 'st_13', name: 'Customized Pages — Display Check', guide: 'Are the customized pages showing up properly in desktop, iOS, and Android?' },
      { id: 'st_14', name: 'Search Banner / Store Cover / Super Store — Uploaded', guide: 'Is the campaign search banner uploaded?' },
      { id: 'st_15', name: 'Search Banner — Promo Mechanics Alignment', guide: 'Is the campaign search banner in line with the promo mechanics?' },
      { id: 'st_16', name: 'Search Banner — Display Check', guide: 'Is the Search Banner showing up properly in desktop, iOS, and Android?' },
      { id: 'st_17', name: 'PDP Banner — Uploaded', guide: 'Is the PDP banner uploaded?' },
      { id: 'st_18', name: 'PDP Banner — Content Check', guide: 'Is the PDP banner product name, campaign logo, price, duration, images, GWPs, offerings correct?' },
      { id: 'st_19', name: 'Store Categories — Created in Seller Center', guide: 'Are the campaign store categories already created in the seller center? (correct name based on campaign)' },
      { id: 'st_20', name: 'Store Categories — Tagged with Listings', guide: 'Are the campaign store categories tagged with the corresponding listings?' },
      { id: 'st_21', name: 'Store Categories — Mobile Display', guide: 'Are the campaign store categories appearing in the mobile version with tagged listings inside?' },
    ]
  },
  {
    id: 'sis_dday',
    title: 'Store-in-Store Merchandising — D-Day Setup',
    items: [
      { id: 'sd_01', name: 'Mega Campaign Page — D-Day Assets Uploaded', guide: 'Are the D-Day assets uploaded?' },
      { id: 'sd_02', name: 'Mega Campaign Page — D-Day Display Check', guide: 'Are the D-Day assets showing up properly in desktop, iOS, and Android?' },
      { id: 'sd_03', name: 'Mega Campaign Page — Product Modules', guide: 'Do product modules display adequate product suggestions? (e.g. Slider Product Recommendation, Tab Switchable Products, etc.)' },
      { id: 'sd_04', name: 'Mega Campaign Page — Banner Clickability', guide: 'Check if all banners are clickable and redirect to the correct page.' },
      { id: 'sd_05', name: 'Mega Campaign Page — PB vs SiS Comparison', guide: 'Compare PB to SiS (GWP, price, texts, thumbnails)' },
      { id: 'sd_06', name: 'Main Landing Page — D-Day Assets Uploaded', guide: 'Are the D-Day assets uploaded?' },
      { id: 'sd_07', name: 'Main Landing Page — Links to Customized Pages', guide: 'Are the D-Day assets properly linked to the correct customized pages?' },
      { id: 'sd_08', name: 'Main Landing Page — D-Day Display Check', guide: 'Are the D-Day assets showing up properly in desktop, iOS, and Android?' },
      { id: 'sd_09', name: 'Main Landing Page — Product Modules', guide: 'Do product modules display adequate product suggestions? (e.g. Slider Product Recommendation, Tab Switchable Products, etc.)' },
      { id: 'sd_10', name: 'Customized Pages — Linked from SiS', guide: 'Is the customized page linked from the proper SiS asset?' },
      { id: 'sd_11', name: 'Customized Pages — Display Check', guide: 'Are the customized pages showing up properly in desktop, iOS, and Android?' },
      { id: 'sd_12', name: 'Search Banner / Store Cover — Uploaded', guide: 'Is the campaign search banner uploaded?' },
      { id: 'sd_13', name: 'Search Banner — Display Check', guide: 'Is the Search Banner showing up properly in desktop, iOS, and Android?' },
      { id: 'sd_14', name: 'PDP Banner — Uploaded', guide: 'Is the PDP banner uploaded?' },
      { id: 'sd_15', name: 'PDP Banner — Content Check', guide: 'Is the PDP banner product name, campaign logo, price, duration, images, GWPs, offerings correct?' },
      { id: 'sd_16', name: 'Store Categories — Created in Seller Center', guide: 'Are the campaign store categories already created in the seller center? (correct name based on campaign)' },
      { id: 'sd_17', name: 'Store Categories — Tagged with Listings', guide: 'Are the campaign store categories tagged with the corresponding listings?' },
      { id: 'sd_18', name: 'Store Categories — Mobile Display', guide: 'Are the campaign store categories appearing in the mobile version with tagged listings inside?' },
    ]
  },
  {
    id: 'product_merch',
    title: 'Product Merchandising',
    items: [
      { id: 'pm_01', name: 'Hero Thumbnail — Content Check', guide: 'Are the campaign hero thumbnails properly checked? e.g. product image, pricing, quantity, mechanics' },
      { id: 'pm_02', name: 'Hero Thumbnail — Display Check', guide: 'Are the Hero Thumbnails showing up properly in desktop, iOS, and Android?' },
      { id: 'pm_03', name: 'Campaign Supplementary Thumbnails — Content Check', guide: 'Are the campaign supplementary thumbnails properly checked? e.g. product image, pricing, quantity, mechanics' },
      { id: 'pm_04', name: 'Campaign Supplementary Thumbnails — Display Check', guide: 'Are the Campaign Thumbnails showing up properly in desktop, iOS, and Android?' },
      { id: 'pm_05', name: 'Lorikeet', guide: 'Are the SKU lorikeets complete/updated? e.g. child SKUs, quantity, images' },
      { id: 'pm_06', name: 'Key Attributes', guide: 'Are the SKU Key Attributes complete?' },
    ]
  },
  {
    id: 'traffic_tools',
    title: 'Traffic Tools',
    items: [
      { id: 'tt_01', name: 'Super Store — Module Setup', guide: 'Have we set up the Super Store module?' },
      { id: 'tt_02', name: 'Super Store — Display Check', guide: 'Is the Super Store Module showing up properly in desktop, iOS, and Android?' },
    ]
  },
  {
    id: 'trackers',
    title: 'Trackers',
    items: [
      { id: 'tr_01', name: 'Pre-Campaign Tracker', guide: 'Do we have the pre-campaign tracker template ready? (to monitor brand performance)' },
      { id: 'tr_02', name: 'Campaign D-Day Tracker', guide: 'Do we have the campaign D-Day tracker template ready? (to monitor brand performance)' },
    ]
  },
  {
    id: 'after_party',
    title: 'After Party',
    items: [
      // type: 'yesno' — this item renders a Yes/No selector instead of the
      // usual Pending/Done/In Progress/N/A status dropdown (see
      // yesNoOptions() / handleStatusChange() in app.js). Selecting "Yes"
      // prompts for the after-party start/end dates, which then become
      // this entry's checklist deadline for compliance purposes and are
      // written into the row's Notes column. Selecting "No" is treated as
      // a completion sign — nothing further to do.
      { id: 'ap_01', name: 'Joining the After Party?', guide: 'Is this entry (brand/platform/region) joining the After Party extension?', type: 'yesno' },
    ]
  }
];

const TOTAL_ITEMS = CHECKLIST_SECTIONS.reduce((sum, s) => sum + s.items.length, 0);
