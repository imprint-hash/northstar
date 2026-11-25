//! Northstar escrow: a buyer locks USDC for a shipment. The money can only go two ways:
//! to the seller, when the deal's verifier attests that the named ship has docked at the named
//! port (with the Telegraph receipt of the evidence), or back to the buyer after the deadline.
//! The verifier can never send the money anywhere else, and can never touch it after the deadline.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc");

#[program]
pub mod northstar {
    use super::*;

    pub fn open_deal(ctx: Context<OpenDeal>, deal_id: u64, amount: u64, vessel: String, port: String, deadline: i64) -> Result<()> {
        require!(amount > 0, NsError::ZeroAmount);
        require!(vessel.len() <= 32 && port.len() <= 24, NsError::TooLong);
        require!(deadline > Clock::get()?.unix_timestamp, NsError::DeadlinePassed);
        let d = &mut ctx.accounts.deal;
        d.buyer = ctx.accounts.buyer.key();
        d.seller = ctx.accounts.seller.key();
        d.verifier = ctx.accounts.verifier.key();
        d.mint = ctx.accounts.mint.key();
        d.deal_id = deal_id;
        d.amount = amount;
        d.vessel = vessel;
        d.port = port;
        d.deadline = deadline;
        d.status = Status::Open;
        d.checks = 0;
        d.last_code = 0;
        d.evidence = [0u8; 32];
        d.bump = ctx.bumps.deal;
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.buyer_token.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.buyer.to_account_info() }), amount)?;
        emit!(DealOpened { deal: d.key(), amount, deadline });
        Ok(())
    }

    /// Record a check that did not release (ship at sea, at anchor, dark...). Keeps an on-chain trail.
    pub fn record_check(ctx: Context<Verify>, code: u8, evidence: [u8; 32]) -> Result<()> {
        let d = &mut ctx.accounts.deal;
        require!(d.status == Status::Open, NsError::NotOpen);
        require!(Clock::get()?.unix_timestamp < d.deadline, NsError::DeadlinePassed);
        d.checks = d.checks.saturating_add(1);
        d.last_code = code;
        d.evidence = evidence;
        emit!(Checked { deal: d.key(), code, evidence });
        Ok(())
    }

    /// Pay the seller: only the verifier, only before the deadline, only to the seller fixed at opening.
    pub fn release(ctx: Context<Release>, evidence: [u8; 32]) -> Result<()> {
        let d = &ctx.accounts.deal;
        require!(d.status == Status::Open, NsError::NotOpen);
        require!(Clock::get()?.unix_timestamp < d.deadline, NsError::DeadlinePassed);
        let (buyer, id, bump, amount) = (d.buyer, d.deal_id.to_le_bytes(), d.bump, d.amount);
        let seeds: &[&[u8]] = &[b"deal", buyer.as_ref(), &id, &[bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.seller_token.to_account_info(), authority: ctx.accounts.deal.to_account_info() }, &[seeds]), amount)?;
        let d = &mut ctx.accounts.deal;
        d.status = Status::Released;
        d.evidence = evidence;
        d.checks = d.checks.saturating_add(1);
        d.last_code = 1;
        emit!(Released { deal: d.key(), amount, evidence });
        Ok(())
    }

    /// The buyer's safety net: after the deadline, an unreleased deal refunds the buyer. Nobody can stop it.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let d = &ctx.accounts.deal;
        require!(d.status == Status::Open, NsError::NotOpen);
        require!(Clock::get()?.unix_timestamp >= d.deadline, NsError::TooEarly);
        let (buyer, id, bump, amount) = (d.buyer, d.deal_id.to_le_bytes(), d.bump, d.amount);
        let seeds: &[&[u8]] = &[b"deal", buyer.as_ref(), &id, &[bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.buyer_token.to_account_info(), authority: ctx.accounts.deal.to_account_info() }, &[seeds]), amount)?;
        let d = &mut ctx.accounts.deal;
        d.status = Status::Refunded;
        emit!(Refunded { deal: d.key(), amount });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct OpenDeal<'info> {
    #[account(mut)] pub buyer: Signer<'info>,
    /// CHECK: any wallet; fixed as the only possible payee.
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the agent key allowed to attest arrival; it can only release to `seller`.
    pub verifier: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = buyer, space = 8 + Deal::SIZE, seeds = [b"deal", buyer.key().as_ref(), &deal_id.to_le_bytes()], bump)]
    pub deal: Account<'info, Deal>,
    #[account(init, payer = buyer, seeds = [b"vault", deal.key().as_ref()], bump, token::mint = mint, token::authority = deal)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Verify<'info> {
    pub verifier: Signer<'info>,
    #[account(mut, has_one = verifier)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub verifier: Signer<'info>,
    #[account(mut, has_one = verifier)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = deal.mint, token::authority = deal.seller)]
    pub seller_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = deal.mint, token::authority = deal.buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Deal {
    pub buyer: Pubkey, pub seller: Pubkey, pub verifier: Pubkey, pub mint: Pubkey,
    pub deal_id: u64, pub amount: u64, pub deadline: i64,
    pub vessel: String, pub port: String,
    pub status: Status, pub checks: u32, pub last_code: u8, pub evidence: [u8; 32], pub bump: u8,
}
impl Deal { pub const SIZE: usize = 32 * 4 + 8 * 3 + (4 + 32) + (4 + 24) + 1 + 4 + 1 + 32 + 1; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Status { Open, Released, Refunded }

#[event] pub struct DealOpened { pub deal: Pubkey, pub amount: u64, pub deadline: i64 }
#[event] pub struct Checked { pub deal: Pubkey, pub code: u8, pub evidence: [u8; 32] }
#[event] pub struct Released { pub deal: Pubkey, pub amount: u64, pub evidence: [u8; 32] }
#[event] pub struct Refunded { pub deal: Pubkey, pub amount: u64 }

#[error_code]
pub enum NsError {
    #[msg("Amount must be above zero")] ZeroAmount,
    #[msg("Vessel or port name too long")] TooLong,
    #[msg("The deadline has passed")] DeadlinePassed,
    #[msg("The deal is not open")] NotOpen,
    #[msg("Refunds open only after the deadline")] TooEarly,
}
