import type {SupabaseClient} from "@supabase/supabase-js";

/** Filter in Postgres, before its REST row limit can truncate a large company. */
export async function selectedSupportCustomerGuids(db:SupabaseClient,companyId:string,ids:string[]){
 if(!ids.length)return new Set<string>();
 const {data,error}=await db.from("customers").select("id,tally_ledger_guid").eq("company_id",companyId).eq("is_available",true).in("id",ids);
 if(error)throw error;
 return new Set<string>((data??[]).map(row=>String(row.tally_ledger_guid)).filter(id=>id&&id!=="null"));
}
