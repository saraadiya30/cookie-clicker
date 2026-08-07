Game.registerMod("cookie-bot-auto", {
    init: function() {
        if (window.autoCookiePureClickInterval) clearInterval(window.autoCookiePureClickInterval);
        if (window.autoCookieGodzamokInterval) clearInterval(window.autoCookieGodzamokInterval);
        if (window.autoCookieBuyInterval) clearInterval(window.autoCookieBuyInterval);

        // bersihin sisa highlight dari versi sebelumnya (sebelum fitur highlight dihapus total) --
        // one-time cleanup doang, biar warna yang kelanjur nempel di elemen DOM (dari sebelum
        // di-reload) ilang, dan gak ada residual style pas mod ini jalan generasi baru
        for (let obj of Game.ObjectsById) {
            let el = document.getElementById('product' + obj.id);
            if (el) {
                el.style.boxShadow = '';
                el.style.backgroundColor = '';
                el.style.transition = '';
            }
        }
        for (let i = 0; i < Game.UpgradesInStore.length; i++) {
            let el = document.getElementById('upgrade' + i);
            if (el) {
                el.style.boxShadow = '';
                el.style.backgroundColor = '';
                el.style.transition = '';
            }
        }

        // cache 'Get lucky' / 'Lucky day' biar gak query Game.Has tiap tick
        let hasLucky = { getLucky: false, luckyDay: false };
        function refreshLuckyCache() {
            hasLucky.getLucky = Game.Has('Get lucky');
            hasLucky.luckyDay = Game.Has('Lucky day');
        }
        refreshLuckyCache();

        // reserve buat combo Lucky: persentase dari cookies bank saat itu (bukan kelipatan CPS),
        // biar gak pernah lebih besar dari cookies itu sendiri (anti-deadlock)
        const BANK_BUFFER_RATIO = 0.7;

        // reserve umum yang SELALU aktif (bukan cuma pas Lucky) -- jaga-jaga buat golden cookie reward
        // atau kebutuhan mendadak lain, dihitung dari kelipatan CPS biar konsisten di skala berapapun
        const CPS_BUFFER_SECONDS = 15;

        // gabungin 2 jenis reserve: buffer gede buat combo Lucky (persentase bank, cuma aktif kalau
        // 'Get lucky'/'Lucky day' kepasang) dan buffer kecil yang selalu aktif (kelipatan CPS) --
        // yang dipake adalah yang PALING GEDE di antara keduanya
        function computeBankBuffer(cookies, cpsRaw) {
            let luckyBuffer = (hasLucky.getLucky || hasLucky.luckyDay) ? cookies * BANK_BUFFER_RATIO : 0;
            let generalBuffer = (cpsRaw || 0) * CPS_BUFFER_SECONDS;
            return Math.max(luckyBuffer, generalBuffer);
        }

        // building minigame (Farm/Bank/Temple/Wizard Tower) -- dipake di beberapa tempat
        // (sugar lump priority-unlock, floor jual-beli combo Godzamok), dideklarasiin di sini
        // (bukan di dekat pemakaian terakhirnya) biar urutannya jelas dibaca
        const MINIGAME_BUILDING_IDS = [2, 5, 6, 7]; // Farm, Bank, Temple, Wizard Tower

        // itung total CPS 'mentah' (sebelum mult global prestige/Heavenly Power/milk/dst) dari 1 building,
        // udah termasuk level bonus & buildMult (dewa) -- ditarik jadi 1 fungsi biar gak duplikat logic
        // yang sama di beberapa tempat (getItemData, tryGodzamokCombo, trySpendSugarLumps)
        function getBuildingTotalCps(obj) {
            try {
                return typeof obj.storedTotalCps === 'number' ? obj.storedTotalCps
                    : (typeof obj.cps === 'function' ? obj.cps(obj) * obj.amount : 0);
            } catch (e) {
                return 0;
            }
        }

        // hitung berapa unit dari 'obj' yang affordable dari 'budget' (pakai formula harga asli game:
        // basePrice, priceIncrease, free, modifyBuildingPrice), dibatasi maxUnits, dan opsional perUnitCap
        // (harga per unit gak boleh lebih dari ini -- dipake buat trivial-buy) -- ditarik jadi 1 fungsi
        // biar gak duplikat logic geometric series di beberapa fungsi beli (trivial-buy, combo-farm, priority-rebuy)
        function calcAffordableUnits(obj, budget, maxUnits, perUnitCap) {
            let cap = perUnitCap !== undefined ? perUnitCap : Infinity;
            let growthRatio = Game.priceIncrease || 1.15;
            let free = obj.free || 0;
            let amount = obj.amount;
            let cum = 0;
            let n = 0;

            while (n < maxUnits) {
                let p = obj.basePrice * Math.pow(growthRatio, Math.max(0, (amount + n) - free));
                if (typeof Game.modifyBuildingPrice === 'function') p = Game.modifyBuildingPrice(obj, p);
                p = Math.ceil(p);

                if (p > cap) break;
                if (cum + p > budget) break;

                cum += p;
                n++;
            }

            return { n, cost: cum };
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

            // rasio buat convert nilai CPS "mentah" (storedCps/storedTotalCps, sebelum mult global
            // prestige/Heavenly Power/milk/dst) ke skala yang sama kayak Game.cookiesPsRaw, biar
            // adil dibandingin sama upgrade berbasis `power` (yang udah pake cookiesPsRaw langsung)
            let globalMultRaw = (Game.buildingCps && Game.buildingCps > 0) ? (Game.cookiesPsRaw / Game.buildingCps) : 1;

            if (isUpgrade) {
                try {
                    if (item.buildingTie) {
                        let b = item.buildingTie;
                        deltaCps = getBuildingTotalCps(b) * globalMultRaw;
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
                    // storedCps udah termasuk level bonus & buildMult (dewa), tinggal dikali rasio
                    // global buat nyamain skala sama cookiesPsRaw
                    let rawCps = typeof item.storedCps === 'number' ? item.storedCps
                        : (typeof item.cps === 'function' ? item.cps(item) : 0);
                    deltaCps = rawCps * globalMultRaw;
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

        // upgrade yang efeknya gak bisa dihitung presisi (Kitten dkk) -> beli semua yang affordable
        // -- SEBELUMNYA dibatasin maks 5% dari cookies bank saat itu, tapi itu bikin upgrade penting
        //    ketunda kelamaan di late-game (harga sering di atas 5% bank walau tetep worth dibeli).
        //    Upgrade tipe ini emang selalu net-positive buat dimiliki (beda sama building yang
        //    mahal-murahnya perlu ditimbang), jadi selama masih di dalam bankBuffer, gak ada
        //    alasan buat nunda -- cap-nya dihapus, cuma dibatasin bankBuffer doang
        // -- diurutin termurah dulu, biar makin banyak upgrade yang kebeli sebelum budget abis di tick itu
        // -- kecualiin upgrade yang trigger keputusan besar (Grandmapocalypse dkk), biar dibeli manual aja
        const EXCLUDED_FROM_AUTOBUY = ['One mind', 'Communal brainsweep', 'Elder Pact'];
        function tryOpportunisticUpgrades(bankBuffer) {
            let candidates = [];
            for (let up of Game.UpgradesInStore) {
                if (!up || up.pool === 'toggle' || up.name === 'Elder Covenant') continue;
                if (EXCLUDED_FROM_AUTOBUY.includes(up.name)) continue;
                if (up.buildingTie || up.power) continue; // ini udah dihandle sistem payback biasa

                let cost = 0;
                try {
                    cost = typeof up.getPrice === 'function' ? up.getPrice() : (up.price || 0);
                } catch (e) {
                    cost = 0;
                }
                if (cost > 0) candidates.push({ up, cost });
            }

            candidates.sort((a, b) => a.cost - b.cost); // termurah duluan

            for (let cand of candidates) {
                if (Game.cookies - bankBuffer >= cand.cost) {
                    cand.up.buy();
                }
            }
        }

        function hasClickBuffActive() {
            for (let key in Game.buffs) {
                let buff = Game.buffs[key];
                if (buff && buff.multClick && buff.multClick > 1) return true;
            }
            return false;
        }

        // estimasi untung-rugi jual building buat combo Godzamok, sebelum beneran dieksekusi
        // -- baseline (clickBefore, oldFactor, remainingTime) di-snapshot SEKALI per tick di tryGodzamokCombo,
        //    biar evaluasi building ke-2/3/dst gak ke-skip gara-gara efek sale building sebelumnya di tick yang sama
        //    (FIX: sebelumnya baca Game.mouseCps()/Game.hasBuff('Devastation') live tiap panggilan, jadi
        //    building A yang kejual duluan mengubah baseline buat building B/C/D sehingga mereka keliatan
        //    gak profitable padahal aslinya profitable -- makanya cuma 1 jenis building yang kejual per tick)
        function estimateGodzamokEV(obj, godzamokLvl, baseline, sellAmount) {
            let sold = sellAmount;
            if (!sold || sold <= 0) return { profitable: false };
            let floor = obj.amount - sold; // titik terendah abis dijual (0 buat building biasa, >=1 buat minigame)

            // sisi untung: kenaikan nilai klik x sisa waktu Devastation x rate klik bot (10/detik dari interval 100ms)
            let clickBefore = baseline.clickBefore;
            let rate = godzamokLvl === 1 ? 0.01 : godzamokLvl === 2 ? 0.005 : 0.0025;
            let deltaMultClick = sold * rate;

            let oldFactor = baseline.oldFactor;
            let newFactor = oldFactor + deltaMultClick;
            let clickAfter = clickBefore * (newFactor / oldFactor);
            let deltaClickValue = clickAfter - clickBefore;

            let remainingTime = baseline.remainingTime; // buff baru mulai dari 10 detik
            let clicksRemaining = remainingTime * 10;

            let expectedGain = deltaClickValue * clicksRemaining;

            // sisi rugi: rebuyCost dihitung persis pakai formula asli game, mulai dari floor (bukan selalu dari 0,
            // biar akurat buat building yang cuma dijual sebagian kayak building minigame yang nyisa 1 unit)
            let growthRatio = Game.priceIncrease || 1.15;
            let free = obj.free || 0;
            let rebuyCost = 0;
            for (let k = floor; k < floor + sold; k++) {
                let p = obj.basePrice * Math.pow(growthRatio, Math.max(0, k - free));
                if (typeof Game.modifyBuildingPrice === 'function') p = Game.modifyBuildingPrice(obj, p);
                rebuyCost += Math.ceil(p);
            }

            let sellMult = typeof obj.getSellMultiplier === 'function' ? obj.getSellMultiplier() : 0.25;
            const SAFETY_MARGIN = 0.05; // anggap refund 5% lebih kecil dari aktual, biar netCost gak underestimate
            let safeSellMult = Math.max(0, sellMult - SAFETY_MARGIN);
            let netCost = rebuyCost * (1 - safeSellMult); // yang beneran ilang abis siklus jual-beli (dengan buffer aman)

            return { profitable: expectedGain > netCost, expectedGain, netCost };
        }

        // Godzamok combo: jual building yang kontribusinya <1% dari total CPS buat trigger buff klik (Devastation)
        // -- KHUSUS pas Click Frenzy aktif (bukan Frenzy biasa), dan cuma kalau estimasi untungnya beneran positif
        let godzamokPrevAmount = {}; // { buildingId: jumlah sebelum dijual, buat prioritas rebuy }
        const GODZAMOK_THRESHOLD = 0.01; // 1% dari total raw CPS
        function tryGodzamokCombo() {
            if (!Game.hasGod) return;
            let godzamokLvl = Game.hasGod('ruin');
            if (!godzamokLvl) return; // Godzamok gak lagi di-slot
            if (!hasClickBuffActive()) return; // khusus Click Frenzy, gak ada fallback ke Frenzy biasa

            let totalCps = Game.buildingCps || 0; // pakai skala yang sama kayak storedTotalCps (sebelum mult global)
            if (totalCps <= 0) return;

            // snapshot baseline SEKALI di awal tick -- biar semua building dievaluasi terhadap
            // klik value & status Devastation yang sama, bukan yang udah berubah gara-gara sale
            // building sebelumnya di tick yang sama
            let existingDevastation = Game.hasBuff ? Game.hasBuff('Devastation') : null;
            let baseline = {
                clickBefore: Game.mouseCps ? Game.mouseCps() : 0,
                oldFactor: existingDevastation ? existingDevastation.multClick : 1,
                remainingTime: existingDevastation ? existingDevastation.time : 10
            };

            for (let obj of Game.ObjectsById) {
                if (!obj || obj.amount <= 0) continue;

                // building minigame (Farm/Bank/Temple/Wizard Tower) boleh ikut dijual buat combo,
                // tapi disisain minimal 1 unit -- jual habis ke 0 gak ngilangin progress minigame-nya
                // (dikonfirmasi: cuma bikin tab-nya ke-hide sementara sampe beli 1 lagi), tapi nyisain 1
                // itu jaga-jaga murah biar fungsi bot yang gantung ke situ (misal tryCastForceHand
                // yang baca wizardTower.minigame langsung) tetep punya akses tanpa perlu nebak-nebak
                let minSellFloor = MINIGAME_BUILDING_IDS.includes(obj.id) ? 1 : 0;
                if (obj.amount <= minSellFloor) continue; // udah di floor, gak ada yang bisa dijual lagi

                let buildingCps = getBuildingTotalCps(obj);

                let ratio = buildingCps / totalCps;
                if (ratio < GODZAMOK_THRESHOLD) {
                    let sellAmount = obj.amount - minSellFloor;
                    let ev = estimateGodzamokEV(obj, godzamokLvl, baseline, sellAmount);
                    if (!ev.profitable) continue; // estimasi rugi, skip

                    godzamokPrevAmount[obj.id] = Math.max(godzamokPrevAmount[obj.id] || 0, obj.amount);
                    obj.sell(sellAmount); // jual sisa di atas floor, bukan semua
                }
            }
        }

        // beli banyak-banyak building yang RASIO untung-combo-Godzamoknya paling bagus
        // (rate combo per biaya efektif rebuy -- makin murah harganya relatif, makin bagus buat di-farm)
        // -- khusus late-game dimana CPS growth udah gak signifikan, jadi cookies bank
        //    diarahin buat numpuk AMOUNT building murah, biar combo Godzamok makin untung tiap sale
        // -- karena rate combo (sold * rate) itu SAMA buat semua building (cuma tergantung level Godzamok,
        //    bukan jenis building), rasio ini pada dasarnya = 1 / harga-efektif -- jadi yang menang
        //    selalu building dengan harga per-unit paling murah relatif ke reward combo-nya
        //
        // gabungan dari 2 fungsi lama (tryBuyForGodzamokCombo + tryBuyTrivialBuildings) -- keduanya
        // sama-sama "beli building murah", tapi kriteria "murah"-nya beda, dan overlap-nya bikin salah
        // satu jadi percuma kalau dijalanin terpisah (combo-farm selalu duluan & makan surplus abis-abisan,
        // jadi trivial-buy gak pernah kebagian). Sekarang cuma jalan SALAH SATU tergantung Ruin ke-slot apa nggak:
        // -- Ruin DI-SLOT: mode combo -- prioritas rasio untung-Godzamok (rate/harga-efektif), budget dipake
        //    abis-abisan, cap 500 unit per building biar otomatis nyebar ke beberapa jenis building.
        //    Building yang harga per-unitnya > 1 jam cpsRaw di-skip total dari kandidat (dicek per-unit
        //    sepanjang batch beli, bukan cuma unit pertama) -- kalau segitu mahal relatif ke income,
        //    gak sehat buat terus-terusan di-farm buat combo.
        // -- Ruin GAK di-slot: mode trivial -- fallback lama, cuma beli yang harganya di bawah 1% dari cpsRaw
        //    (gak ada gunanya farm buat combo kalau combo-nya sendiri gak aktif)
        // dipake di tryBuyCheapBuildings mode fallback (Ruin gak di-slot)
        const TRIVIAL_BUY_RATIO = 0.01; // 1% dari cpsRaw

        function tryBuyCheapBuildings(bankBuffer, godzamokLvl, cpsRaw) {
            if (godzamokLvl) {
                let rate = godzamokLvl === 1 ? 0.01 : godzamokLvl === 2 ? 0.005 : 0.0025;
                const SAFETY_MARGIN = 0.05;
                const MAX_PRICE_SECONDS = 3600; // skip building yang harganya lebih dari 1 jam cpsRaw -- kalau segitu mahal, gak sehat buat di-farm terus-terusan
                let maxPrice = cpsRaw * MAX_PRICE_SECONDS;

                let candidates = [];
                for (let obj of Game.ObjectsById) {
                    if (!obj) continue;

                    let price;
                    try {
                        price = obj.getPrice();
                    } catch (e) {
                        continue;
                    }
                    if (!price || price <= 0) continue;
                    if (price > maxPrice) continue; // kemahalan relatif ke CPS, skip total dari kandidat

                    let sellMult = typeof obj.getSellMultiplier === 'function' ? obj.getSellMultiplier() : 0.25;
                    let safeSellMult = Math.max(0, sellMult - SAFETY_MARGIN);
                    let effectiveCost = price * (1 - safeSellMult); // biaya bersih siklus jual-beli buat unit ini nanti
                    if (effectiveCost <= 0) continue;

                    candidates.push({ obj, ratio: rate / effectiveCost });
                }

                candidates.sort((a, b) => b.ratio - a.ratio); // rasio terbaik (paling murah efektif) diproses duluan

                let budget = Math.max(0, Game.cookies - bankBuffer);

                for (let cand of candidates) {
                    if (budget <= 0) break;

                    let result = calcAffordableUnits(cand.obj, budget, 500, maxPrice);

                    if (result.n > 0) {
                        cand.obj.buy(result.n); // satu kali panggil, satu kali suara
                        budget -= result.cost;
                    }
                }
            } else {
                let trivialCost = cpsRaw * TRIVIAL_BUY_RATIO;

                for (let obj of Game.ObjectsById) {
                    if (!obj) continue;

                    let budget = Math.max(0, Game.cookies - bankBuffer);
                    let result = calcAffordableUnits(obj, budget, 200, trivialCost);

                    if (result.n > 0) {
                        obj.buy(result.n); // satu kali panggil -> satu kali suara, bukan n kali
                    }
                }
            }
        }

        // beli balik bulk building bekas Godzamok, sampai balik ke jumlah semula
        // -- GAK pake bankBuffer: rebuy ini restore state yang barusan sengaja dijual buat combo,
        //    bukan pembelian diskresioner baru, jadi seluruh cookies yang ada boleh dipake full
        // -- diurutin dari yang PALING MURAH direbuy duluan, biar kalau budget tetep gak cukup
        //    buat semuanya, yang gagal kebeli itu yang paling mahal (bukan asal urutan building id)
        function tryPriorityRebuy() {
            let sorted = Object.keys(godzamokPrevAmount).map(function(id) {
                let obj = Game.ObjectsById[id];
                let price = Infinity;
                if (obj) {
                    try { price = obj.getPrice(); } catch (e) { price = Infinity; }
                }
                return { id, price };
            }).sort((a, b) => a.price - b.price);

            for (let entry of sorted) {
                let id = entry.id;
                let obj = Game.ObjectsById[id];
                if (!obj) continue;

                let target = godzamokPrevAmount[id];
                if (obj.amount >= target) {
                    delete godzamokPrevAmount[id]; // udah balik penuh, lepas dari prioritas
                    continue;
                }

                let needed = target - obj.amount;
                let budget = Math.max(0, Game.cookies);
                let result = calcAffordableUnits(obj, budget, needed);

                if (result.n > 0) {
                    obj.buy(result.n); // satu kali panggil, bukan buy(1) diulang
                }
            }
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
                let cps = getBuildingTotalCps(obj);
                if (cps > bestCps) {
                    bestCps = cps;
                    bestObj = obj;
                }
            }

            if (bestObj && Game.lumps >= bestObj.level + 1) {
                bestObj.levelUp();
            }
        }

        // === LOOP KLIK MURNI: cuma Game.ClickCookie(), interval paling cepat ===
        window.autoCookiePureClickInterval = setInterval(function() {
            Game.ClickCookie();
        }, 5);

        // === LOOP GODZAMOK: sell + rebuy, lebih cepat dari loop beli utama biar dapet lebih banyak siklus selama window Click Frenzy ===
        window.autoCookieGodzamokInterval = setInterval(function() {
            tryGodzamokCombo();
            tryPriorityRebuy();
        }, 100);

        // === LOOP LAMBAT: shimmer/lump + keputusan beli & spell (harga/CPS/mana gak berubah secepat itu) ===
        window.autoCookieBuyInterval = setInterval(function() {
            // shimmer (golden cookie/reindeer/wrath) + sugar lump -- gak perlu dicek secepat klik
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

            let cookies = Game.cookies;
            let cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1; // basis efisiensi (deltaCps), konsisten antar buff
            let cpsActual = Game.cookiesPs || cpsRaw; // basis waktu nunggu, refleksiin buff CPS yang lagi aktif (Frenzy dkk)

            // Bank buffer -- gabungan buffer Lucky (persentase bank) & buffer umum (kelipatan CPS, selalu aktif)
            let bankBuffer = computeBankBuffer(cookies, cpsRaw);

            tryCastForceHand();
            tryPopWrinklers();
            trySpendSugarLumps();

            let godzamokLvl = Game.hasGod ? Game.hasGod('ruin') : 0;
            tryBuyCheapBuildings(bankBuffer, godzamokLvl, cpsRaw); // farm/beli building murah -- mode combo kalau Ruin di-slot, mode trivial kalau nggak

            tryOpportunisticUpgrades(bankBuffer);

            // refresh semua basis kalkulasi, soalnya fungsi-fungsi di atas bisa langsung ngubah cookies/CPS beneran
            cookies = Game.cookies;
            cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1;
            cpsActual = Game.cookiesPs || cpsRaw;
            bankBuffer = computeBankBuffer(cookies, cpsRaw);

            // Elder Pledge: beli langsung kalau affordable (hormatin bankBuffer)
            let pledge = Game.UpgradesById && Game.UpgradesById[74];
            if (pledge && pledge.unlocked && !pledge.bought && Game.UpgradesInStore.includes(pledge)) {
                if (cookies - bankBuffer >= pledge.getPrice()) {
                    pledge.buy();
                }
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

            // Cari target utama (payback period terbaik: timeToSave + payback)
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

            // Logika stepping-stone: cek apakah beli sesuatu yang lebih murah dulu bikin nyampe ke bestTarget lebih cepat
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
                }
            }
        }, 1000);

        Game.Notify('Cookie Bot', 'Bot aktif & siap jalan!', [16, 5]);
    }
});
