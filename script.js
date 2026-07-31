Game.registerMod("cookie-bot-auto", {
    init: function() {
        if (window.autoCookieClickInterval) clearInterval(window.autoCookieClickInterval);
        if (window.autoCookieBuyInterval) clearInterval(window.autoCookieBuyInterval);

        let lastEl = null;
        const MILESTONES = [1, 10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600];

        // cache 'Get lucky' / 'Lucky day' biar gak query Game.Has tiap tick
        let hasLucky = { getLucky: false, luckyDay: false };
        function refreshLuckyCache() {
            hasLucky.getLucky = Game.Has('Get lucky');
            hasLucky.luckyDay = Game.Has('Lucky day');
        }
        refreshLuckyCache();

        function clear() {
            if (lastEl) {
                lastEl.style.boxShadow = '';
                lastEl.style.backgroundColor = '';
                lastEl = null;
            }
        }

        function findEl(item, isUpgrade) {
            if (!item) return null;
            if (isUpgrade) {
                let index = Game.UpgradesInStore.indexOf(item);
                return index !== -1 ? document.getElementById('upgrade' + index) : null;
            }
            return document.getElementById('product' + item.id);
        }

        // return null kalau upgrade gak jelas efeknya ke CPS -> di-skip dari kandidat
        function getItemData(item, isUpgrade) {
            let cost = 0;
            try {
                cost = typeof item.getPrice === 'function' ? item.getPrice() : (item.price || 0);
            } catch (e) {
                cost = 0;
            }

            let deltaCps = 0;

            if (isUpgrade) {
                try {
                    if (item.buildingTie) {
                        let b = item.buildingTie;
                        let bCps = (typeof b.cps === 'function') ? b.cps(b) : 0;
                        deltaCps = bCps * b.amount;
                    } else if (item.power) {
                        deltaCps = Game.cookiesPsRaw * (item.power / 100);
                    } else {
                        // efek ke CPS gak diketahui -> jangan dipaksa masuk sistem payback
                        return null;
                    }
                } catch (e) {
                    return null;
                }
            } else {
                try {
                    deltaCps = (typeof item.cps === 'function') ? item.cps(item) : 0;

                    let nextMilestone = MILESTONES.find(m => m > item.amount);
                    if (nextMilestone) {
                        let distance = nextMilestone - item.amount;
                        if (distance <= 5) {
                            let bonusFactor = 1 + ((6 - distance) * 0.5);
                            deltaCps *= bonusFactor;
                        }
                    }
                } catch (e) {
                    deltaCps = 0;
                }
            }

            if (isNaN(deltaCps) || deltaCps <= 0) {
                deltaCps = 0.0001;
            }

            return { item, cost, deltaCps, isUpgrade };
        }

        // cast Force the Hand of Fate begitu mana penuh, langsung sikat golden cookie yang muncul
        function tryCastForceHand() {
            let wizardTower = Game.ObjectsById[7]; // Wizard Tower
            if (!wizardTower || !wizardTower.minigame) return; // Grimoire belum ke-unlock

            let grimoire = wizardTower.minigame;
            let spell = grimoire.spells['hand of fate'];
            if (!spell) return;

            let cost = spell.costMin + grimoire.magicM * spell.costPercent;

            if (grimoire.magic >= grimoire.magicM && grimoire.magic >= cost) {
                grimoire.castSpell(spell);
                Game.Notify('Cookie Bot', 'Force the Hand of Fate dicast!', [16, 5]);

                if (Game.shimmers && Game.shimmers.length > 0) {
                    for (let i = Game.shimmers.length - 1; i >= 0; i--) {
                        if (Game.shimmers[i] && Game.shimmers[i].pop) {
                            Game.shimmers[i].pop();
                        }
                    }
                }
            }
        }

        // auto-trade stock market: beli kalau di bawah resting value & rising, jual kalau di atas resting value & falling
        // -- hormatin bankBuffer pas beli, gak nyolong reserve buat Lucky combo
        function tryTradeStocks(bankBuffer) {
            let bank = Game.Objects['Bank'];
            if (!bank || !bank.minigame) return; // Stock Market belum ke-unlock

            let market = bank.minigame;

            for (let i = 0; i < market.goodsById.length; i++) {
                let good = market.goodsById[i];
                let resting = market.getRestingVal(good.id);

                // Jual dulu: harga di atas resting value & lagi falling (mode 2/4), masih punya stock
                if (good.stock > 0 && good.val > resting && (good.mode === 2 || good.mode === 4)) {
                    market.sellGood(good.id, 10000);
                    continue; // last jadi 2 abis jual, gak bisa langsung beli di tick yang sama
                }

                // Beli: harga di bawah resting value & lagi rising (mode 1/3)
                if (good.val < resting && (good.mode === 1 || good.mode === 3)) {
                    // hitung manual (bukan pakai sentinel 10000) biar budgetnya nyisain bankBuffer
                    let costInS = market.getGoodPrice(good);
                    let overhead = 1 + 0.01 * (20 * Math.pow(0.95, market.brokers));
                    let costPerUnit = Game.cookiesPsRawHighest * costInS * overhead;
                    let budget = Math.max(0, Game.cookies - bankBuffer);
                    let n = costPerUnit > 0 ? Math.floor(budget / costPerUnit) : 0;

                    if (n > 0) {
                        market.buyGood(good.id, n);
                    }
                }
            }
        }

        // Godzamok combo: jual building yang kontribusinya <1% dari total CPS buat trigger buff klik (Devastation)
        let godzamokCooldown = {}; // { buildingId: timestamp boleh dicek lagi }
        let godzamokPrevAmount = {}; // { buildingId: jumlah sebelum dijual, buat prioritas rebuy }
        const GODZAMOK_THRESHOLD = 0.01; // 1% dari total raw CPS
        const GODZAMOK_COOLDOWN_MS = 5 * 60 * 1000; // 5 menit, biar gak sell-rebuy bolak-balik tiap tick

        function hasClickBuffActive() {
            for (let key in Game.buffs) {
                let buff = Game.buffs[key];
                if (buff && buff.multClick && buff.multClick > 1) return true;
            }
            return false;
        }

        function tryGodzamokCombo() {
            if (!Game.hasGod) return;
            let godzamokLvl = Game.hasGod('ruin');
            if (!godzamokLvl) return; // Godzamok gak lagi di-slot
            if (!hasClickBuffActive()) return; // cuma jual pas ada buff klik (Click Frenzy dkk) biar numpuk multiplicative

            let totalCps = Game.cookiesPsRaw || 0;
            if (totalCps <= 0) return;

            let now = Date.now();

            for (let obj of Game.ObjectsById) {
                if (!obj || obj.amount <= 0) continue;
                if (MINIGAME_BUILDING_IDS.includes(obj.id)) continue; // jangan jual habis building minigame, biar akses Grimoire/Stock Market/Pantheon gak keputus
                if (godzamokCooldown[obj.id] && now < godzamokCooldown[obj.id]) continue;

                let buildingCps = 0;
                try {
                    buildingCps = (typeof obj.cps === 'function' ? obj.cps(obj) : 0) * obj.amount;
                } catch (e) {
                    buildingCps = 0;
                }

                let ratio = buildingCps / totalCps;
                if (ratio < GODZAMOK_THRESHOLD) {
                    godzamokPrevAmount[obj.id] = Math.max(godzamokPrevAmount[obj.id] || 0, obj.amount);
                    obj.sell(-1); // jual semua unit building ini sekaligus
                    godzamokCooldown[obj.id] = now + GODZAMOK_COOLDOWN_MS;
                }
            }
        }

        // beli balik bulk (bukan 1-1 secara internal) building bekas Godzamok, sampai balik ke jumlah semula
        // -- hormatin bankBuffer, gak nyolong reserve buat Lucky combo
        function tryPriorityRebuy(bankBuffer) {
            for (let id in godzamokPrevAmount) {
                let obj = Game.ObjectsById[id];
                if (!obj) continue;

                let target = godzamokPrevAmount[id];
                if (obj.amount >= target) {
                    delete godzamokPrevAmount[id]; // udah balik penuh, lepas dari prioritas
                    continue;
                }

                let needed = target - obj.amount;
                for (let i = 0; i < needed; i++) {
                    let price;
                    try {
                        price = obj.getPrice();
                    } catch (e) {
                        break;
                    }
                    if (Game.cookies - bankBuffer >= price) {
                        obj.buy(1);
                    } else {
                        break; // kena buffer / cookies gak cukup, stop buat item ini tick ini
                    }
                }
            }
        }

        // upgrade yang efeknya gak bisa dihitung presisi (Kitten dkk) -> beli opportunistic
        // asal affordable & murah relatif ke bank cookies, bukan ranking payback-period
        // -- hormatin bankBuffer, gak nyolong reserve buat Lucky combo
        const OPPORTUNISTIC_MAX_COST_RATIO = 0.05; // maks 5% dari cookies sekarang
        function tryOpportunisticUpgrades(bankBuffer) {
            for (let up of Game.UpgradesInStore) {
                if (!up || up.pool === 'toggle' || up.name === 'Elder Covenant') continue;
                if (up.buildingTie || up.power) continue; // ini udah dihandle sistem payback biasa

                let cost = 0;
                try {
                    cost = typeof up.getPrice === 'function' ? up.getPrice() : (up.price || 0);
                } catch (e) {
                    cost = 0;
                }

                if (cost > 0 && Game.cookies - bankBuffer >= cost && cost <= Game.cookies * OPPORTUNISTIC_MAX_COST_RATIO) {
                    up.buy();
                }
            }
        }

        // placeholder buat ascension & heavenly upgrades -- BELUM AKTIF.
        // begitu kamu udah pernah ascend, kita verifikasi struktur Game.UpgradesInStore
        // versi heavenly/prestige bareng-bareng dulu, baru diisi logic pemilihan/pembeliannya di sini.
        function tryHeavenlyUpgrades() {
            return; // TODO: isi setelah verifikasi API pasca-ascend pertama
        }

        // auto-pop wrinkler: tunggu Frenzy abis dulu (biar akumulasi 7x maksimal), baru pop begitu penuh
        const WRINKLER_MAX = 10; // naikin ke 14 kalau udah punya Elder Spice + Dragon Guts
        function tryPopWrinklers() {
            if (typeof Game.CollectWrinklers !== 'function') return;
            if (!Game.wrinklers) return;

            let activeWrinklers = Game.wrinklers.filter(w => w && w.phase > 0);
            if (activeWrinklers.length === 0) return;

            // jangan pop kalau Frenzy masih jalan, biar akumulasinya kepakai penuh
            if (Game.hasBuff && Game.hasBuff('Frenzy')) return;

            if (activeWrinklers.length >= WRINKLER_MAX) {
                Game.CollectWrinklers();
            }
        }

        // alokasi sugar lump: unlock minigame dulu (Farm/Bank/Temple/Wizard Tower ke level 1),
        // abis itu level up building kontribusi CPS tertinggi saat ini
        const MINIGAME_BUILDING_IDS = [2, 5, 6, 7]; // Farm, Bank, Temple, Wizard Tower
        function trySpendSugarLumps() {
            if (typeof Game.spendLump !== 'function') return;
            if (!Game.lumps || Game.lumps < 1) return;

            // prioritas 1: unlock minigame (level 1)
            for (let id of MINIGAME_BUILDING_IDS) {
                let obj = Game.ObjectsById[id];
                if (obj && obj.amount > 0 && obj.level < 1 && Game.lumps >= obj.level + 1) {
                    obj.levelUp();
                    return; // 1 lump per tick cukup, biar gak nge-drain semua lump sekaligus
                }
            }

            // prioritas 2: level up building dengan kontribusi CPS tertinggi
            let bestObj = null;
            let bestCps = 0;
            for (let obj of Game.ObjectsById) {
                if (!obj || obj.amount <= 0) continue;
                let cps = 0;
                try {
                    cps = (typeof obj.cps === 'function' ? obj.cps(obj) : 0) * obj.amount;
                } catch (e) {
                    cps = 0;
                }
                if (cps > bestCps) {
                    bestCps = cps;
                    bestObj = obj;
                }
            }

            if (bestObj && Game.lumps >= bestObj.level + 1) {
                bestObj.levelUp();
            }
        }

        // === LOOP CEPAT: klik cookie + shimmer + sugar lump (respons tinggi) ===
        window.autoCookieClickInterval = setInterval(function() {
            Game.ClickCookie();

            if (Game.shimmers && Game.shimmers.length > 0) {
                for (let i = Game.shimmers.length - 1; i >= 0; i--) {
                    if (Game.shimmers[i] && Game.shimmers[i].pop) {
                        Game.shimmers[i].pop();
                    }
                }
            }

            if (Game.lumpT) {
                let age = Date.now() - Game.lumpT;
                if (age >= Game.lumpRipe && !Game.lumpClicking) {
                    Game.lumpClick();
                }
            }
        }, 100);

        // === LOOP LAMBAT: keputusan beli & spell (harga/CPS/mana gak berubah secepat itu) ===
        window.autoCookieBuyInterval = setInterval(function() {
            let cookies = Game.cookies;
            let cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1; // basis efisiensi (deltaCps), konsisten antar buff
            let cpsActual = Game.cookiesPs || cpsRaw; // basis waktu nunggu, refleksiin buff CPS yang lagi aktif (Frenzy dkk)

            // Bank buffer (pakai cache) -- dihitung DULUAN biar semua fungsi beli di bawah bisa hormatin ini
            let bankBuffer = 0;
            if (hasLucky.getLucky) {
                bankBuffer = cpsRaw * 42000;
            } else if (hasLucky.luckyDay) {
                bankBuffer = cpsRaw * 6000;
            }

            tryCastForceHand();
            tryTradeStocks(bankBuffer);
            tryGodzamokCombo();
            tryPopWrinklers();
            trySpendSugarLumps();
            tryPriorityRebuy(bankBuffer);
            tryOpportunisticUpgrades(bankBuffer);
            tryHeavenlyUpgrades();

            // refresh semua basis kalkulasi, soalnya fungsi-fungsi di atas bisa langsung ngubah cookies/CPS beneran
            // (Godzamok jual -> CPS turun, priority rebuy/level up -> CPS naik, dll)
            cookies = Game.cookies;
            cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1;
            cpsActual = Game.cookiesPs || cpsRaw;
            bankBuffer = hasLucky.getLucky ? cpsRaw * 42000 : (hasLucky.luckyDay ? cpsRaw * 6000 : 0);

            // Elder Pledge: beli langsung kalau affordable (hormatin bankBuffer)
            let pledge = Game.UpgradesById && Game.UpgradesById[74];
            if (pledge && pledge.unlocked && !pledge.bought && Game.UpgradesInStore.includes(pledge)) {
                if (cookies - bankBuffer >= pledge.getPrice()) pledge.buy();
            }

            // Kumpulkan kandidat (skip null = upgrade non-CPS yang gak jelas efeknya)
            let candidates = [];
            for (let obj of Game.ObjectsById) {
                if (obj) {
                    let d = getItemData(obj, false);
                    if (d) candidates.push(d);
                }
            }
            for (let up of Game.UpgradesInStore) {
                if (up && up.pool !== 'toggle' && up.name !== 'Elder Covenant') {
                    let d = getItemData(up, true);
                    if (d) candidates.push(d);
                }
            }

            if (candidates.length === 0) return;

            // Cari target utama (payback period terbaik)
            let bestTarget = null;
            let minPP = Infinity;

            for (let cand of candidates) {
                let timeToSave = Math.max(0, cand.cost - cookies) / cpsActual;
                let payback = cand.cost / cand.deltaCps;
                let pp = timeToSave + payback;

                if (pp < minPP) {
                    minPP = pp;
                    bestTarget = cand;
                }
            }

            if (!bestTarget) return;

            // Logika stepping-stone
            let finalAction = bestTarget;
            let timeDirect = Math.max(0, bestTarget.cost - cookies) / cpsActual;
            let bestTimeSaved = 0;

            for (let cand of candidates) {
                if (cand.item === bestTarget.item) continue;
                if (cand.cost >= bestTarget.cost) continue;

                let timeS = Math.max(0, cand.cost - cookies) / cpsActual;
                if (timeS >= timeDirect) continue;

                let newCps = cpsRaw + cand.deltaCps;
                let cookiesAfterS = Math.max(0, cookies + (timeS * cpsActual) - cand.cost);
                let timeTargetAfterS = Math.max(0, bestTarget.cost - cookiesAfterS) / newCps;

                let totalTimeWithS = timeS + timeTargetAfterS;
                let timeSaved = timeDirect - totalTimeWithS;

                if (timeSaved > bestTimeSaved) {
                    bestTimeSaved = timeSaved;
                    finalAction = cand;
                }
            }

            // (bankBuffer udah di-refresh abis fungsi-fungsi di atas jalan)

            // Highlight (box-shadow inset, biar gak ke-crop parent overflow:hidden)
            let targetObj = finalAction.item;
            let el = findEl(targetObj, finalAction.isUpgrade);

            if (el !== lastEl) {
                clear();
                if (el) {
                    el.style.boxShadow = 'inset 0 0 0 3px #00ff00';
                    el.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
                    lastEl = el;
                }
            }

            // Eksekusi beli
            let effectiveCookies = cookies - bankBuffer;

            if (cookies >= finalAction.cost) {
                if (effectiveCookies >= finalAction.cost || cookies < bankBuffer * 0.3) {
                    if (finalAction.isUpgrade) {
                        finalAction.item.buy();
                    } else {
                        finalAction.item.buy(1);
                    }
                    refreshLuckyCache();
                    clear();
                }
            }
        }, 750);

        Game.Notify('Cookie Bot', 'Bot aktif & siap jalan!', [16, 5]);
    }
});
