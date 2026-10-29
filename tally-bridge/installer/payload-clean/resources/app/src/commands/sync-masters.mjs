import { filterCustomersInGroupTree, parseCustomerGroups, parseCustomers, parseLedgers, parseStockGroups, parseStockItems, parseUnits, parseVoucherTypes } from "../tally/masters.mjs";
import { buildCollectionExportXml, postTallyXml } from "../tally/xml.mjs";
import { probeMasterChangeCounter } from "../tally/company-probe.mjs";

const MASTER_EXPORTS = [
  { key: "customerGroups", collectionName: "Meenakshi Customer Groups", tallyType: "Group", tag: "group", fetchFields: "Name,Parent,ParentGUID,GUID,MasterID,AlterID", parse: parseCustomerGroups },
  { key: "units", collectionName: "Meenakshi Units", tallyType: "Unit", tag: "unit", fetchFields: "Name,BaseUnits,GUID,MasterID,AlterID", parse: parseUnits },
  { key: "stockGroups", collectionName: "Meenakshi Stock Groups", tallyType: "StockGroup", tag: "stock group", fetchFields: "Name,Parent,ParentGUID,GUID,MasterID,AlterID", parse: parseStockGroups },
  { key: "stockItems", collectionName: "Meenakshi Stock Items", tallyType: "StockItem", tag: "stock item", fetchFields: "Name,Parent,ParentGUID,StockGroup,StockGroupGUID,BaseUnits,Units,GUID,MasterID,AlterID", parse: parseStockItems },
  { key: "ledgers", collectionName: "Meenakshi Ledgers", tallyType: "Ledger", tag: "ledger", fetchFields: "Name,Parent,GUID,MasterID,AlterID,GSTApplicable,GSTApplicability,Mobile,Phone,PhoneNumber,ContactPerson,AttentionTo", parse: parseLedgers },
  { key: "voucherTypes", collectionName: "Meenakshi Voucher Types", tallyType: "VoucherType", tag: "voucher type", fetchFields: "Name,Parent,GUID,MasterID,AlterID", parse: parseVoucherTypes },
  { key: "customers", collectionName: "Meenakshi Customers", tallyType: "Ledger", tag: "customer ledger", fetchFields: "Name,Parent,ParentGUID,GUID,MasterID,AlterID,PartyGSTIN,LedgerMobile,LedgerPhone,LedgerContact,Email,Address,LedStateName,PinCode", parse: parseCustomers },
];

export async function syncMasters(command, { config, activeCompany }) {
  const syncRunId = typeof command.payload?.syncRunId === "string" ? command.payload.syncRunId : "";
  if (!syncRunId) throw new Error("Master sync command did not contain syncRunId.");
  // Read before the export: anything changed during the sync is caught next time.
  const changeCounter = await probeMasterChangeCounter(config.tallyUrl, activeCompany?.name).catch(() => null);
  // These exports are independent reads. Running them concurrently keeps a
  // fresh sync live while removing the serial 7-request waterfall that made
  // every evidence refresh wait for each master collection in turn.
  const results = await Promise.all(MASTER_EXPORTS.map(async (definition) => {
    const xml = buildCollectionExportXml({
      collectionName: definition.collectionName,
      tallyType: definition.tallyType,
      fetchFields: definition.fetchFields,
      companyName: activeCompany.name,
      childOf: definition.childOf,
    });
    const resultXml = await postTallyXml(config.tallyUrl, xml, { operation: `Export ${definition.tag}s` });
    return [definition.key, definition.parse(resultXml)];
  }));
  const masters = Object.fromEntries(results);
  masters.customers = filterCustomersInGroupTree(masters.customerGroups, masters.customers, "Sundry Debtors");
  return {
    syncRunId,
    activeCompany,
    complete: true,
    changeCounter,
    masters,
    totals: Object.fromEntries(Object.entries(masters).map(([key, records]) => [key, records.length])),
  };
}
