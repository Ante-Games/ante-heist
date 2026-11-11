//! Ante Heist escrow on NEAR.
//!
//! - A sponsor prefunds a mission's reward pot in NEAR and commits to the mission secret's hash.
//! - A player's agent opens a run (`start_run`, with a small refundable storage bond) and may
//!   hire house NPCs (`hire`); the attached NEAR goes straight to the NPC's account.
//! - The settlement key reports the outcome (`settle_run`): a clear pays the fixed reward from
//!   the pot. The off-chain checker decides the outcome; this contract trusts the settler for it.
//! - Revealing the secret (`reveal_secret`) closes the mission and lets anyone re-derive every
//!   run's heist. The sponsor can then withdraw what is left of the pot.

use near_sdk::store::{IterableMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub const STORAGE_BOND: NearToken = NearToken::from_millinear(10); // 0.01 NEAR, returned at settlement

// JSON names are lowercase, matching the game server ("scout"); the capitalised names are still accepted.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Npc {
    #[serde(alias = "Scout")]
    Scout,
    #[serde(alias = "Cryptographer")]
    Cryptographer,
    #[serde(alias = "Operator")]
    Operator,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Cleared,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct NpcInfo {
    pub account: AccountId,
    pub price: NearToken,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Mission {
    pub sponsor: AccountId,
    pub seed_hash: String,
    pub reward: NearToken,
    pub pot: NearToken,
    pub secret: Option<String>,
    pub runs: u64,
    pub clears: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Hire {
    pub npc: Npc,
    pub paid: NearToken,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Run {
    pub mission_id: String,
    pub player: AccountId,
    pub started_ns: u64,
    pub hires: Vec<Hire>,
    pub outcome: Option<Outcome>,
    pub reward_paid: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    settler: AccountId,
    scout: NpcInfo,
    cryptographer: NpcInfo,
    operator: NpcInfo,
    missions: IterableMap<String, Mission>,
    runs: Vector<Run>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, settler: AccountId, scout: AccountId, cryptographer: AccountId, operator: AccountId) -> Self {
        Self {
            owner,
            settler,
            scout: NpcInfo { account: scout, price: NearToken::from_millinear(200) },
            cryptographer: NpcInfo { account: cryptographer, price: NearToken::from_millinear(300) },
            operator: NpcInfo { account: operator, price: NearToken::from_millinear(300) },
            missions: IterableMap::new(b"m"),
            runs: Vector::new(b"r"),
        }
    }

    // ── owner ────────────────────────────────────────────────────────────

    pub fn set_npc(&mut self, npc: Npc, account: AccountId, price: NearToken) {
        self.assert_owner();
        *self.npc_mut(npc) = NpcInfo { account, price };
    }

    pub fn set_settler(&mut self, settler: AccountId) {
        self.assert_owner();
        self.settler = settler;
    }

    // ── sponsor ──────────────────────────────────────────────────────────

    /// Create a mission, or top up its pot. `seed_hash` = hex sha256 of the mission secret.
    #[payable]
    pub fn fund_mission(&mut self, mission_id: String, seed_hash: String, reward: NearToken) {
        let deposit = env::attached_deposit();
        require!(deposit > NearToken::from_yoctonear(0), "attach NEAR to fund the pot");
        let caller = env::predecessor_account_id();
        match self.missions.get_mut(&mission_id) {
            Some(m) => {
                require!(m.secret.is_none(), "mission is closed");
                require!(m.seed_hash == seed_hash && m.reward == reward, "mission exists with a different seed hash or reward");
                m.pot = m.pot.saturating_add(deposit);
            }
            None => {
                require!(seed_hash.len() == 64 && hex::decode(&seed_hash).is_ok(), "seed_hash must be 64 hex chars");
                require!(reward > NearToken::from_yoctonear(0), "reward must be positive");
                require!(mission_id.len() <= 64, "mission_id too long");
                self.missions.insert(
                    mission_id,
                    Mission { sponsor: caller, seed_hash, reward, pot: deposit, secret: None, runs: 0, clears: 0 },
                );
            }
        }
    }

    /// After the secret is revealed, the sponsor takes back what is left of the pot.
    pub fn withdraw_pot(&mut self, mission_id: String) -> Promise {
        let m = self.missions.get_mut(&mission_id).unwrap_or_else(|| env::panic_str("no such mission"));
        require!(env::predecessor_account_id() == m.sponsor, "only the sponsor");
        require!(m.secret.is_some(), "reveal the secret first");
        let amount = m.pot;
        require!(amount > NearToken::from_yoctonear(0), "pot is empty");
        m.pot = NearToken::from_yoctonear(0);
        Promise::new(m.sponsor.clone()).transfer(amount)
    }

    // ── player's agent ───────────────────────────────────────────────────

    /// Open a run. Attach exactly the storage bond (0.01 NEAR); it is returned at settlement.
    #[payable]
    pub fn start_run(&mut self, mission_id: String) -> u64 {
        require!(env::attached_deposit() == STORAGE_BOND, "attach exactly 0.01 NEAR as a refundable storage bond");
        let m = self.missions.get_mut(&mission_id).unwrap_or_else(|| env::panic_str("no such mission"));
        require!(m.secret.is_none(), "mission is closed");
        require!(m.pot >= m.reward, "the pot cannot cover a reward right now");
        m.runs += 1;
        self.runs.push(Run {
            mission_id,
            player: env::predecessor_account_id(),
            started_ns: env::block_timestamp(),
            hires: Vec::new(),
            outcome: None,
            reward_paid: NearToken::from_yoctonear(0),
        });
        (self.runs.len() - 1) as u64
    }

    /// Hire a house NPC for this run. The price goes to the NPC's account; any excess is refunded.
    /// Returns the hire index the game server checks before answering.
    #[payable]
    pub fn hire(&mut self, run_id: u64, npc: Npc) -> u32 {
        let info = self.npc(npc).clone();
        let deposit = env::attached_deposit();
        let caller = env::predecessor_account_id();
        let run = self.runs.get_mut(run_id as u32).unwrap_or_else(|| env::panic_str("no such run"));
        require!(caller == run.player, "only the run's player can hire");
        require!(run.outcome.is_none(), "run is settled");
        require!(deposit >= info.price, format!("attach at least {} yoctoNEAR", info.price.as_yoctonear()));
        require!(run.hires.len() < 32, "hire limit reached");
        run.hires.push(Hire { npc, paid: info.price });
        let index = (run.hires.len() - 1) as u32;
        Promise::new(info.account).transfer(info.price).detach();
        let excess = deposit.saturating_sub(info.price);
        if excess > NearToken::from_yoctonear(0) {
            Promise::new(caller).transfer(excess).detach();
        }
        index
    }

    // ── settlement key ───────────────────────────────────────────────────

    pub fn settle_run(&mut self, run_id: u64, cleared: bool) {
        require!(env::predecessor_account_id() == self.settler, "only the settler");
        let run = self.runs.get_mut(run_id as u32).unwrap_or_else(|| env::panic_str("no such run"));
        require!(run.outcome.is_none(), "run is already settled");
        run.outcome = Some(if cleared { Outcome::Cleared } else { Outcome::Failed });
        let player = run.player.clone();
        let mission_id = run.mission_id.clone();
        let mut payout = STORAGE_BOND;
        let m = self.missions.get_mut(&mission_id).unwrap_or_else(|| env::panic_str("mission missing"));
        if cleared {
            m.clears += 1;
            if m.pot >= m.reward {
                m.pot = m.pot.saturating_sub(m.reward);
                payout = payout.saturating_add(m.reward);
                self.runs.get_mut(run_id as u32).unwrap().reward_paid = m.reward;
            }
        }
        Promise::new(player).transfer(payout).detach();
    }

    /// Reveal the mission secret (checked against the committed hash) and close the mission.
    pub fn reveal_secret(&mut self, mission_id: String, secret: String) {
        let caller = env::predecessor_account_id();
        require!(caller == self.settler || caller == self.owner, "only the settler or owner");
        let m = self.missions.get_mut(&mission_id).unwrap_or_else(|| env::panic_str("no such mission"));
        require!(m.secret.is_none(), "already revealed");
        require!(hex::encode(env::sha256(secret.as_bytes())) == m.seed_hash, "secret does not match the committed hash");
        m.secret = Some(secret);
    }

    // ── views ────────────────────────────────────────────────────────────

    pub fn get_run(&self, run_id: u64) -> Option<Run> {
        self.runs.get(run_id as u32).cloned()
    }

    pub fn get_mission(&self, mission_id: String) -> Option<Mission> {
        self.missions.get(&mission_id).cloned()
    }

    pub fn get_npc(&self, npc: Npc) -> NpcInfo {
        self.npc(npc).clone()
    }

    pub fn get_settler(&self) -> AccountId {
        self.settler.clone()
    }

    pub fn run_count(&self) -> u64 {
        self.runs.len() as u64
    }

    // ── internal ─────────────────────────────────────────────────────────

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn npc(&self, npc: Npc) -> &NpcInfo {
        match npc {
            Npc::Scout => &self.scout,
            Npc::Cryptographer => &self.cryptographer,
            Npc::Operator => &self.operator,
        }
    }

    fn npc_mut(&mut self, npc: Npc) -> &mut NpcInfo {
        match npc {
            Npc::Scout => &mut self.scout,
            Npc::Cryptographer => &mut self.cryptographer,
            Npc::Operator => &mut self.operator,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(caller: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acc(caller))
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(100))
            .build());
    }

    const SECRET: &str = "mission secret";

    fn hash() -> String {
        hex::encode(env::sha256(SECRET.as_bytes()))
    }

    fn setup() -> Contract {
        ctx("owner.testnet", NearToken::from_yoctonear(0));
        let mut c = Contract::new(acc("owner.testnet"), acc("settler.testnet"), acc("scout.testnet"), acc("crypto.testnet"), acc("operator.testnet"));
        ctx("sponsor.testnet", NearToken::from_near(3));
        c.fund_mission("m1".into(), hash(), NearToken::from_near(1));
        c
    }

    fn start(c: &mut Contract, player: &str) -> u64 {
        ctx(player, STORAGE_BOND);
        c.start_run("m1".into())
    }

    #[test]
    fn fund_start_hire_settle() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        assert_eq!(id, 0);
        ctx("lead.testnet", NearToken::from_millinear(250));
        assert_eq!(c.hire(id, Npc::Scout), 0);
        ctx("lead.testnet", NearToken::from_millinear(300));
        assert_eq!(c.hire(id, Npc::Operator), 1);
        let run = c.get_run(id).unwrap();
        assert_eq!(run.hires.len(), 2);
        assert_eq!(run.hires[0].npc, Npc::Scout);
        assert_eq!(run.hires[0].paid, NearToken::from_millinear(200));

        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.settle_run(id, true);
        let run = c.get_run(id).unwrap();
        assert_eq!(run.outcome, Some(Outcome::Cleared));
        assert_eq!(run.reward_paid, NearToken::from_near(1));
        let m = c.get_mission("m1".into()).unwrap();
        assert_eq!(m.pot, NearToken::from_near(2));
        assert_eq!((m.runs, m.clears), (1, 1));
    }

    #[test]
    fn npc_names_are_lowercase_in_json_and_accept_capitalised() {
        assert_eq!(near_sdk::serde_json::to_string(&Npc::Cryptographer).unwrap(), "\"cryptographer\"");
        let a: Npc = near_sdk::serde_json::from_str("\"scout\"").unwrap();
        let b: Npc = near_sdk::serde_json::from_str("\"Scout\"").unwrap();
        assert_eq!((a, b), (Npc::Scout, Npc::Scout));
    }

    #[test]
    fn failed_run_keeps_the_pot() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.settle_run(id, false);
        assert_eq!(c.get_run(id).unwrap().outcome, Some(Outcome::Failed));
        assert_eq!(c.get_mission("m1".into()).unwrap().pot, NearToken::from_near(3));
    }

    #[test]
    #[should_panic(expected = "only the run's player can hire")]
    fn others_cannot_hire_on_your_run() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("mallory.testnet", NearToken::from_near(1));
        c.hire(id, Npc::Scout);
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn hire_needs_the_price() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("lead.testnet", NearToken::from_millinear(299));
        c.hire(id, Npc::Operator);
    }

    #[test]
    #[should_panic(expected = "only the settler")]
    fn only_settler_settles() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("lead.testnet", NearToken::from_yoctonear(0));
        c.settle_run(id, true);
    }

    #[test]
    #[should_panic(expected = "already settled")]
    fn settle_once() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.settle_run(id, false);
        c.settle_run(id, true);
    }

    #[test]
    #[should_panic(expected = "run is settled")]
    fn no_hires_after_settlement() {
        let mut c = setup();
        let id = start(&mut c, "lead.testnet");
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.settle_run(id, false);
        ctx("lead.testnet", NearToken::from_near(1));
        c.hire(id, Npc::Scout);
    }

    #[test]
    #[should_panic(expected = "storage bond")]
    fn start_needs_the_bond() {
        let mut c = setup();
        ctx("lead.testnet", NearToken::from_yoctonear(0));
        c.start_run("m1".into());
    }

    #[test]
    fn empty_pot_still_settles_without_reward() {
        ctx("owner.testnet", NearToken::from_yoctonear(0));
        let mut c = Contract::new(acc("owner.testnet"), acc("settler.testnet"), acc("scout.testnet"), acc("crypto.testnet"), acc("operator.testnet"));
        ctx("sponsor.testnet", NearToken::from_near(1));
        c.fund_mission("m1".into(), hash(), NearToken::from_near(1));
        let a = start(&mut c, "a.testnet");
        let b = start(&mut c, "b.testnet");
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.settle_run(a, true);
        c.settle_run(b, true);
        assert_eq!(c.get_run(a).unwrap().reward_paid, NearToken::from_near(1));
        assert_eq!(c.get_run(b).unwrap().reward_paid, NearToken::from_yoctonear(0));
        assert_eq!(c.get_mission("m1".into()).unwrap().clears, 2);
    }

    #[test]
    #[should_panic(expected = "pot cannot cover")]
    fn no_new_runs_when_pot_is_short() {
        let mut c = setup();
        for p in ["a.testnet", "b.testnet", "c.testnet"] {
            let id = start(&mut c, p);
            ctx("settler.testnet", NearToken::from_yoctonear(0));
            c.settle_run(id, true);
        }
        start(&mut c, "d.testnet");
    }

    #[test]
    fn reveal_closes_and_sponsor_withdraws() {
        let mut c = setup();
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.reveal_secret("m1".into(), SECRET.into());
        assert_eq!(c.get_mission("m1".into()).unwrap().secret.as_deref(), Some(SECRET));
        ctx("sponsor.testnet", NearToken::from_yoctonear(0));
        c.withdraw_pot("m1".into()).detach();
        assert_eq!(c.get_mission("m1".into()).unwrap().pot, NearToken::from_yoctonear(0));
    }

    #[test]
    #[should_panic(expected = "does not match")]
    fn reveal_checks_the_hash() {
        let mut c = setup();
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.reveal_secret("m1".into(), "wrong".into());
    }

    #[test]
    #[should_panic(expected = "mission is closed")]
    fn closed_mission_takes_no_runs() {
        let mut c = setup();
        ctx("settler.testnet", NearToken::from_yoctonear(0));
        c.reveal_secret("m1".into(), SECRET.into());
        start(&mut c, "lead.testnet");
    }

    #[test]
    fn owner_reprices_npcs() {
        let mut c = setup();
        ctx("owner.testnet", NearToken::from_yoctonear(0));
        c.set_npc(Npc::Scout, acc("scout2.testnet"), NearToken::from_millinear(50));
        let info = c.get_npc(Npc::Scout);
        assert_eq!(info.account, acc("scout2.testnet"));
        assert_eq!(info.price, NearToken::from_millinear(50));
    }
}
