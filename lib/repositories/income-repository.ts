// lib/income-repository.ts
import { supabase } from '../supabase';
import { CleanIncome } from '@/lib/services/trade-calculator';

export async function upsertIncomes(incomes: CleanIncome[]) {
  if (incomes.length === 0) return [];

  const { data, error } = await supabase
    .from('income_logs')
    .upsert(incomes, { onConflict: 'income_id' })
    .select();

  if (error) {
    console.error('資金流水存取失敗:', error.message);
    throw error;
  }
  return data;
}