import { loadSync } from "https://deno.land/std@0.199.0/dotenv/mod.ts";
import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import { encode } from "https://deno.land/std/encoding/hex.ts"
import {
  applyParamsToScript,
  Constr,
  Data,
  fromHex,
  fromText,
  generateSeedPhrase,
  Kupmios,
  Lucid,
  Script,
  sha256,
  toHex,
} from "https://deno.land/x/lucid@0.10.1/mod.ts";
import {
  calculateDifficultyNumber,
  calculateInterlink,
  getDifficulty,
  getDifficultyAdjustement,
  incrementU8Array,
  readValidator,
} from "./utils.ts";

loadSync({ export: true, allowEmptyValues: true });

// Excludes datum field because it is not needed
// and it's annoying to type.
type Genesis = {
  validator: string;
  validatorHash: string;
  validatorAddress: string;
  boostrapHash: string;
  outRef: { txHash: string; index: number };
};

const delay = (ms: number | undefined) =>
  new Promise((res) => setTimeout(res, ms));

const make_miner_request = (c, d) => {
    const promise = new Promise((resolve, reject) => {
              c.write(d).then( ()=> {
              const b=new Uint8Array(512);
              c.read(b).then( ()=> {
                  resolve([c,b]);
              });
              });
            })
   return promise;
};

const mine = new Command()
  .description("Start the miner")
  .env("KUPO_URL=<value:string>", "Kupo URL", { required: true })
  .env("OGMIOS_URL=<value:string>", "Ogmios URL", { required: true })
  .env("SUBMIT_API_URL=<value:string>", "Submit API Url", { required: false })
  .env("EXTRA=<value:string>", "Data to include in the extra field", { required: false })
  .option("-p, --preview", "Use testnet")
  .action(async ({ preview, submitApiUrl, ogmiosUrl, kupoUrl }) => {
    //--------------------------------------------------------------------------------------------
    // put your miner core config in the .env file
    // syntax: hostname:port or only port if on the same machine.
    // examples:
    // 
    //  - default: MINER_CORE_URLS=":2023"            single miner on localhost port 2023
    //  - multiple miners on remote machines:  MINER_CORE_URLS="123.456.789.123:2023,234.567.890.123:4057,234.567.890.123:4058"
    //--------------------------------------------------------------------------------------------
    var miners = [
        {port: 2023}, // don't change this, kept for backward compatibility.
    ]
    var minersEnv = Deno.env.get("MINER_CORE_URLS");
    if (minersEnv != undefined) {
        var parts = minersEnv.split(",");
        miners = [];
        parts.forEach( (x) => {
            var subparts = x.split(':');
            if (subparts.length < 2) {
                miners.push({port: parseInt(subparts[0])});
            } else if (subparts.length == 2) {
                miners.push({hostname: (subparts[0].trim().length > 0 ? subparts[0] : '127.0.0.1') , port: parseInt(subparts[1])});
            } else {
                console.log(`\x1b[31merror: invalid miner core: ${x}`);
            }
        });
    }


    const genesisFile = Deno.readTextFileSync(
        `genesis/${preview ? "preview" : "mainnet"}.json`,
    );

    const { validatorHash, validatorAddress }: Genesis = JSON
        .parse(
          genesisFile,
      );

    const provider = new Kupmios(kupoUrl, ogmiosUrl);
    const lucid = await Lucid.new(provider, preview ? "Preview" : "Mainnet");

    lucid.selectWalletFromSeed(Deno.readTextFileSync("seed.txt"));

    if (submitApiUrl == undefined) {
        console.log("------------------------------------------------------------------------------------------");
        console.log("info: \x1b[32mcardano-submit-api\x1b[0m is not configured and \x1b[31mwill not be used\x1b[0m. To enable it, add SUBMIT_API_URL=<url> to your .env file. Default value is: \x1b[33mhttp://localhost:8090/api/submit/tx\x1b[0m" );
        console.log("Using cardano-submit-api increases the chances for successful tx submission. It will be tried first and in case of failure, kupmios is used.");
        console.log("------------------------------------------------------------------------------------------");
    } else {
        console.log("submit-api:", submitApiUrl);
    }
    console.log("connecting to:");
    miners.forEach( (x) => {
        console.log(`- ${JSON.stringify(x)}`)
    })

    // try to connect to all cores and ignore non responding cores

    var miner_connections = [];
    while (miner_connections.length<1) {
        miner_connections = (await Promise.allSettled(miners.map(async (x) => Deno.connect(x)))).map( (x) => {console.log(`${x.status == 'fulfilled' ? x.value.remoteAddr['hostname'] + ':' + x.value.remoteAddr['port'] : JSON.stringify(x)} => ${x.status == 'fulfilled' ? '\x1b[32mOK\x1b[0m' : '\x1b[31mERROR\x1b[0m'}`); return x}).filter( (x)=> x.status == "fulfilled" ).map( (x) => x.value );
        if (miner_connections.length < 1) {
            console.log("no miner cores found, retrying...");
            await delay(5000);
        }
    }

    if (miner_connections.length < miners.length) {
        console.log("warning: some miner cores could not be connected, continuing with the working ones.");
    }

    var time_start = Date.now();
    var n_hashes = 0;

    while (true) {

      let validatorUTXOs = await lucid.utxosAt(validatorAddress);

      let validatorOutRef = validatorUTXOs.find(
        (u) => u.assets[validatorHash + fromText("lord tuna")],
      )!;

      let validatorState = validatorOutRef.datum!;

      let state = Data.from(validatorState) as Constr<
        string | bigint | string[]
      >;

      let nonce = new Uint8Array(16);

      crypto.getRandomValues(nonce);

      let targetState = new Constr(0, [
        // nonce: ByteArray
        toHex(nonce),
        // block_number: Int
        state.fields[0] as bigint,
        // current_hash: ByteArray
        state.fields[1] as bigint,
        // leading_zeros: Int
        state.fields[2] as bigint,
        // difficulty_number: Int
        state.fields[3] as bigint,
        //epoch_time: Int
        state.fields[4] as bigint,
      ]);

      let targetHash: Uint8Array;

      let difficulty: {
        leadingZeros: bigint;
        difficulty_number: bigint;
      };

      console.log("Mining...");
      let timer = new Date().valueOf();
      let hashCounter = 0;
      let startTime = Date.now();
      while (true) {
          console.log(`New block not found, updating state. Found: ${n_hashes}, rate: ${(3600*1000*n_hashes/(Date.now() - time_start)).toFixed(4)} /h running since ${((Date.now() - time_start)*0.001).toFixed(1)} s, ${miner_connections.length} active mining-cores`);

          timer = new Date().valueOf();
          validatorUTXOs = await lucid.utxosAt(validatorAddress);

          validatorOutRef = validatorUTXOs.find(
            (u) => u.assets[validatorHash + fromText("lord tuna")],
          )!;

          if (validatorState !== validatorOutRef.datum!) {
            validatorState = validatorOutRef.datum!;

            state = Data.from(validatorState) as Constr<
              string | bigint | string[]
            >;

            nonce = new Uint8Array(16);

            crypto.getRandomValues(nonce);

            targetState = new Constr(0, [
              // nonce: ByteArray
              toHex(nonce),
              // block_number: Int
              state.fields[0] as bigint,
              // current_hash: ByteArray
              state.fields[1] as bigint,
              // leading_zeros: Int
              state.fields[2] as bigint,
              // difficulty_number: Int
              state.fields[3] as bigint,
              //epoch_time: Int
              state.fields[4] as bigint,
            ]);
            console.log("STATE = ", Data.to(targetState));
            console.log(`=> DIFFICULTY = \x1b[34m${(state.fields[2] as bigint)} ${(state.fields[3] as bigint)}\x1b[0m BLOCK = ${state.fields[0] as bigint} EPOCH = ${state.fields[4] as bigint}`);

            try{
            var datum_timestamp = Number(state.fields[5]);
            var now_timestamp = new Date().getTime();
            console.log(`=> DATUM TIMESTAMP: ${datum_timestamp} (${new Date(datum_timestamp).toISOString()})`);
            if (now_timestamp - datum_timestamp > 24*3600*1000) {
                console.log("warning: timestamp from utxo datum seems to be in the past, check sync status of kupo and your time settings.");
            }
            } catch (err) {
            }
          }

        targetHash = sha256(sha256(fromHex(Data.to(targetState))));

        const d = new TextEncoder().encode(`${Data.to(targetState)} ${""+(state.fields[2] as bigint)} ${""+(state.fields[3] as bigint)}\n`);
        const miner_promises = miner_connections.map( (x) => make_miner_request(x, d) );

        var found_nonce = false;
        try {
            var bs = await Promise.allSettled(miner_promises);

            for(var m=0; m<bs.length; m++) {
                var b = bs[m].value[1];
                var result_str = (new TextDecoder().decode(b)).trim();
                // miner found a nonce!
                if (result_str.substr(0,1) != ".") {
                    // decode result
                    var parts = result_str.split(":");
                    targetHash = parts[1];
                    if (parts[0].length > 32) {
                        for(var k=0;k<16;k++) {
                            nonce[k] = parseInt(parts[0].substr(8+2*k,2),16);
                        }
                    } else {
                        for(var k=0;k<16;k++) {
                            nonce[k] = parseInt(parts[0].substr(2*k,2),16);
                        }
                    }
                    targetState.fields[0] = toHex(nonce);
                    console.log(`NONCE: [\x1b[32mFROM ${bs[m].value[0].remoteAddr['hostname']}\x1b[0m:\x1b[33m${bs[m].value[0].remoteAddr['port']}\x1b[0m]: ${targetState.fields[0]}`);
                    targetHash = sha256(sha256(fromHex(Data.to(targetState))));
                    var check_hash = toHex(targetHash);
                    if (JSON.stringify(check_hash.trim().substring(0,64).toUpperCase()) == JSON.stringify(parts[1].trim().substring(0,64).toUpperCase())) {
                        console.log("CHECK OK:",toHex(targetHash));
                    } else {
                        console.log("\x1b[31mCHECK FAILED\x1b[0m:", check_hash, "/", parts[1], " state has changed in the meantime. If you see this message often, this could indicate a problem with your setup.");
                    }
                }

                difficulty = getDifficulty(targetHash);
                const { leadingZeros, difficulty_number } = difficulty;

                if (
                  leadingZeros > (state.fields[2] as bigint) ||
                  (leadingZeros == (state.fields[2] as bigint) &&
                    difficulty_number < (state.fields[3] as bigint))
                ) {
                  found_nonce = true;
                }
                if (found_nonce) {
                    break;
                }
            }

            if (found_nonce) {
                break;
            }
        } catch (e) {
            console.log(e);
        }

        incrementU8Array(nonce);

        targetState.fields[0] = toHex(nonce);
      }

      const realTimeNow = Number((Date.now() / 1000).toFixed(0)) * 1000 - 60000;

      const interlink = calculateInterlink(toHex(targetHash), difficulty, {
        leadingZeros: state.fields[2] as bigint,
        difficulty_number: state.fields[3] as bigint,
      }, state.fields[7] as string[]);

      let epoch_time = (state.fields[4] as bigint) +
        BigInt(90000 + realTimeNow) -
        (state.fields[5] as bigint);

      let difficulty_number = state.fields[3] as bigint;
      let leading_zeros = state.fields[2] as bigint;

      if (
        state.fields[0] as bigint % 2016n === 0n &&
        state.fields[0] as bigint > 0
      ) {
        const adjustment = getDifficultyAdjustement(epoch_time, 1_209_600_000n);

        epoch_time = 0n;

        const new_difficulty = calculateDifficultyNumber(
          {
            leadingZeros: state.fields[2] as bigint,
            difficulty_number: state.fields[3] as bigint,
          },
          adjustment.numerator,
          adjustment.denominator,
        );

        difficulty_number = new_difficulty.difficulty_number;
        leading_zeros = new_difficulty.leadingZeros;
      }

      // calculateDifficultyNumber();

      const postDatum = new Constr(0, [
        (state.fields[0] as bigint) + 1n,
        toHex(targetHash),
        leading_zeros,
        difficulty_number,
        epoch_time,
        BigInt(90000 + realTimeNow),
        extra ? fromText(extra) : 0n,
        interlink,
      ]);

      const outDat = Data.to(postDatum);

      console.log(`Found next datum: ${outDat}`);

      const mintTokens = { [validatorHash + fromText("TUNA")]: 5000000000n };
      const masterToken = { [validatorHash + fromText("lord tuna")]: 1n };
      try {
        const readUtxo = await lucid.utxosByOutRef([{
          txHash:
            "01751095ea408a3ebe6083b4de4de8a24b635085183ab8a2ac76273ef8fff5dd",
          outputIndex: 0,
        }]);
        const txMine = await lucid
          .newTx()
          .collectFrom(
            [validatorOutRef],
            Data.to(new Constr(1, [toHex(nonce)])),
          )
          .payToAddressWithData(
            validatorAddress,
            { inline: outDat },
            masterToken,
          )
          .mintAssets(mintTokens, Data.to(new Constr(0, [])))
          .readFrom(readUtxo)
          .validTo(realTimeNow + 180000)
          .validFrom(realTimeNow)
          .complete();

        const signed = await txMine.sign().complete();

        if (submitApiUrl != undefined) {
            try {
                const req = new Request(submitApiUrl, {
                      method: "POST",
                      body: signed.txSigned.to_bytes(),
                      headers: {
                        'content-type': 'application/cbor',
                      }
                    });
                var resp = await fetch(req);
                console.log("SIGNED:", new TextDecoder().decode(encode(signed.txSigned.to_bytes())));
                console.log("CARDANO-SUBMIT-API RESPONSE:", resp);
            } catch (err) {
                console.log("info: submission with the submit-api failed, using default provider as backup. This will most likely be fine. If you're running a local node, it is recommended to have cardano-submit-api installed for redundancy of transaction submission.");

                try {
                    await signed.submit();
                } catch (err) {
                    console.log("error: second tx submission attempt (kupmios) failed:");
                    console.log(err);
                    console.log("trying again...");
                    await delay(2000);
                    await signed.submit();
                }
            }
        } else {
                try {
                    await signed.submit();
                } catch (err) {
                    console.log("error: first tx submission attempt failed:");
                    console.log(err);
                    console.log("trying again...");

                    try {
                        await delay(2000);
                        await signed.submit();
                    } catch (err) {
                        console.log("error: second tx submission attempt failed:");
                        console.log(err);
                        console.log("final attempt...");
                        await signed.submit();
                    }
                }
        }

        console.log(`TX HASH: ${signed.toHash()}`);
        console.log("Waiting for confirmation...");

        n_hashes += 1;

        // // await lucid.awaitTx(signed.toHash());
        await delay(3000);
      } catch (e) {
        console.log(e);
      }
    }
  });

const genesis = new Command()
  .description("Create block 0")
  .env("KUPO_URL=<value:string>", "Kupo URL", { required: true })
  .env("OGMIOS_URL=<value:string>", "Ogmios URL", { required: true })
  .option("-p, --preview", "Use testnet")
  .action(async ({ preview, ogmiosUrl, kupoUrl }) => {
    const unAppliedValidator = readValidator();

    const provider = new Kupmios(kupoUrl, ogmiosUrl);
    const lucid = await Lucid.new(provider, preview ? "Preview" : "Mainnet");
    lucid.selectWalletFromSeed(Deno.readTextFileSync("seed.txt"));

    const utxos = await lucid.wallet.getUtxos();

    if (utxos.length === 0) {
      throw new Error("No UTXOs Found");
    }

    const initOutputRef = new Constr(0, [
      new Constr(0, [utxos[0].txHash]),
      BigInt(utxos[0].outputIndex),
    ]);

    const appliedValidator = applyParamsToScript(unAppliedValidator.script, [
      initOutputRef,
    ]);

    const validator: Script = {
      type: "PlutusV2",
      script: appliedValidator,
    };

    const boostrapHash = toHex(sha256(sha256(fromHex(Data.to(initOutputRef)))));

    const validatorAddress = lucid.utils.validatorToAddress(validator);

    const validatorHash = lucid.utils.validatorToScriptHash(validator);

    const masterToken = { [validatorHash + fromText("lord tuna")]: 1n };

    const timeNow = Number((Date.now() / 1000).toFixed(0)) * 1000 - 60000;

    // State
    const preDatum = new Constr(0, [
      // block_number: Int
      0n,
      // current_hash: ByteArray
      boostrapHash,
      // leading_zeros: Int
      5n,
      // difficulty_number: Int
      65535n,
      // epoch_time: Int
      0n,
      // current_posix_time: Int
      BigInt(90000 + timeNow),
      // extra: Data
      0n,
      // interlink: List<Data>
      [],
    ]);

    const datum = Data.to(preDatum);

    const tx = await lucid
      .newTx()
      .collectFrom(utxos)
      .payToContract(validatorAddress, { inline: datum }, masterToken)
      .mintAssets(masterToken, Data.to(new Constr(1, [])))
      .attachMintingPolicy(validator)
      .validFrom(timeNow)
      .validTo(timeNow + 180000)
      .complete();

    const signed = await tx.sign().complete();

    try {
      await signed.submit();

      console.log(`TX Hash: ${signed.toHash()}`);

      await lucid.awaitTx(signed.toHash());

      console.log(`Completed and saving genesis file.`);

      Deno.writeTextFileSync(
        `genesis/${preview ? "preview" : "mainnet"}.json`,
        JSON.stringify({
          validator: validator.script,
          validatorHash,
          validatorAddress,
          boostrapHash,
          datum,
          outRef: { txHash: utxos[0].txHash, index: utxos[0].outputIndex },
        }),
      );
    } catch (e) {
      console.log(e);
    }
  });

const init = new Command().description("Initialize the miner").action(() => {
  const seed = generateSeedPhrase();

  Deno.writeTextFileSync("seed.txt", seed);

  console.log(`Miner wallet initialized and saved to seed.txt`);
});

const address = new Command()
  .description("Check address balance")
  .env("KUPO_URL=<value:string>", "Kupo URL", { required: true })
  .env("OGMIOS_URL=<value:string>", "Ogmios URL", { required: true })
  .option("-p, --preview", "Use testnet")
  .action(async ({ preview, ogmiosUrl, kupoUrl }) => {
    const provider = new Kupmios(kupoUrl, ogmiosUrl);
    const lucid = await Lucid.new(provider, preview ? "Preview" : "Mainnet");

    lucid.selectWalletFromSeed(Deno.readTextFileSync("seed.txt"));

    const address = await lucid.wallet.address();

    const utxos = await lucid.wallet.getUtxos();

    const balance = utxos.reduce((acc, u) => {
      return acc + u.assets.lovelace;
    }, 0n);

    console.log(`Address: ${address}`);
    console.log(`ADA Balance: ${balance / 1_000_000n}`);

    try {
      const genesisFile = Deno.readTextFileSync(
        `genesis/${preview ? "preview" : "mainnet"}.json`,
      );

      const { validatorHash }: Genesis = JSON
        .parse(
          genesisFile,
        );

      const tunaBalance = utxos.reduce((acc, u) => {
        return acc + (u.assets[validatorHash + fromText("TUNA")] ?? 0n);
      }, 0n);

      console.log(`TUNA Balance: ${tunaBalance / 100_000_000n}`);
    } catch {
      console.log(`TUNA Balance: 0`);
    }
  });

await new Command()
  .name("fortuna")
  .description("Fortuna miner")
  .version("0.0.1")
  .command("mine", mine)
  .command("genesis", genesis)
  .command("init", init)
  .command("address", address)
  .parse(Deno.args);
