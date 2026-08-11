import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import {
  signTransaction,
  buildTxJson,
  parseAmountRaw,
  recommendedOu,
  nowTs,
  formatAmount,
} from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { fetchNextNonce } from '../api/nonce';
import { ConfirmDialog } from './ConfirmDialog';
import { extractMethods } from '../tx/abi';
import { PanelSkeleton } from './PanelSkeleton';

export function ContractPanel() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const panelLoading = usePanelLoading();
  const [tab, setTab] = useState<'deploy' | 'call'>('deploy');
  const [source, setSource] = useState(
    '// AML contract source\ncontract Main {\n  field balance: map<address, u64>;\n}',
  );
  const [contractAddr, setContractAddr] = useState('');
  const [method, setMethod] = useState('');
  const [methodList, setMethodList] = useState<string[]>([]);
  const [loadingMethods, setLoadingMethods] = useState(false);
  const [args, setArgs] = useState('{}');
  const [amount, setAmount] = useState('0');
  const [pin, setPin] = useState('');
  const [deployOu, setDeployOu] = useState('');
  const [callOu, setCallOu] = useState('');
  const [confirmAction, setConfirmAction] = useState<'deploy' | 'call' | null>(null);
  const [result, setResult] = useState<string | null>(null);

  if (!wallet) return <PanelSkeleton title="Contracts" rows={3} />;

  // Fee: use the custom OU if the user set one, else the recommended default.
  const deployFee = deployOu.trim() || recommendedOu('program_deploy', 0n);
  const callFee = callOu.trim() || recommendedOu('program_call', 0n);
  const deployFeeRaw = deployFee;
  const callFeeRaw = callFee;

  /** Fetch the contract's ABI/methods when a valid address is entered. */
  const fetchMethods = async () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(contractAddr)) return pushToast('error', 'Invalid contract address');
    setLoadingMethods(true);
    setMethodList([]);
    try {
      const r = await rpc.getProgramInfo(contractAddr);
      if (!r.ok) {
        pushToast('warning', `Contract info: ${r.error ?? 'not found'}`);
        return;
      }
      const methods = extractMethods(r.result);
      setMethodList(methods);
      if (methods.length === 0) {
        pushToast('info', 'No methods found in contract ABI — type the method name manually');
      } else {
        pushToast('success', `Found ${methods.length} method${methods.length === 1 ? '' : 's'}`);
        if (!method && methods[0]) setMethod(methods[0]);
      }
    } catch (e) {
      pushToast('error', `Fetch methods failed: ${(e as Error).message}`);
    } finally {
      setLoadingMethods(false);
    }
  };

  const requestDeploy = () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!pin) return pushToast('error', 'PIN required');
    if (!source.trim()) return pushToast('error', 'Source is empty');
    setConfirmAction('deploy');
  };

  const requestCall = () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(contractAddr)) return pushToast('error', 'Invalid contract address');
    if (!method) return pushToast('error', 'Method name required');
    if (!pin) return pushToast('error', 'PIN required');
    setConfirmAction('call');
  };

  const handleDeploy = async () => {
    setConfirmAction(null);
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!pin) return pushToast('error', 'PIN required');
    if (!source.trim()) return pushToast('error', 'Source is empty');

    panelLoading.show(
      'Deploying contract',
      'Compiling AML source and submitting the deploy transaction…',
    );
    try {
      // Step 1: compile on RPC node
      const compile = await rpc.compileAml(source);
      if (!compile.ok || !compile.result) {
        throw new Error(`Compile failed: ${compile.error}`);
      }
      const bytecode = compile.result.bytecode;

      // Step 2: build & sign program_deploy tx
      const nonce = await fetchNextNonce(rpc, wallet.addr);
      const fee = deployFeeRaw;
      const encryptedData = JSON.stringify({ bytecode });

      const tx = signTransaction({
        secretKey: wallet.sk,
        publicKeyB64: wallet.pubB64,
        fields: {
          from: wallet.addr,
          to: wallet.addr,
          amount: '0',
          nonce,
          ou: fee,
          timestamp: nowTs(),
          op_type: 'program_deploy',
          encrypted_data: encryptedData,
        },
      });

      const submit = await rpc.submitTx(JSON.parse(buildTxJson(tx)));
      if (!submit.ok || !submit.result) throw new Error(`Submit failed: ${submit.error}`);

      setResult(tx.hash);
      pushToast('success', `Contract deployed (hash=${tx.hash.slice(0, 12)}...)`);
    } catch (e) {
      pushToast('error', `Deploy failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  const handleCall = async () => {
    setConfirmAction(null);
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(contractAddr)) return pushToast('error', 'Invalid contract address');
    if (!method) return pushToast('error', 'Method name required');
    if (!pin) return pushToast('error', 'PIN required');

    panelLoading.show('Calling contract', 'Signing and submitting the contract call…');
    try {
      let argsObj: unknown = undefined;
      try {
        argsObj = args.trim() ? JSON.parse(args) : undefined;
      } catch {
        throw new Error('Args must be valid JSON');
      }
      const amountRaw = parseAmountRaw(amount || '0');
      const nonce = await fetchNextNonce(rpc, wallet.addr);
      const fee = callFeeRaw;
      const encryptedData = JSON.stringify({ method, args: argsObj });

      const tx = signTransaction({
        secretKey: wallet.sk,
        publicKeyB64: wallet.pubB64,
        fields: {
          from: wallet.addr,
          to: contractAddr,
          amount: amountRaw,
          nonce,
          ou: fee,
          timestamp: nowTs(),
          op_type: 'program_call',
          encrypted_data: encryptedData,
        },
      });

      const submit = await rpc.submitTx(JSON.parse(buildTxJson(tx)));
      if (!submit.ok || !submit.result) throw new Error(`Submit failed: ${submit.error}`);

      setResult(tx.hash);
      pushToast('success', `Contract called (hash=${tx.hash.slice(0, 12)}...)`);
    } catch (e) {
      pushToast('error', `Call failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Smart Contracts (AML)</div>
      </div>

      <div className="tab-bar">
        <div className={`tab ${tab === 'deploy' ? 'active' : ''}`} onClick={() => setTab('deploy')}>
          Deploy
        </div>
        <div className={`tab ${tab === 'call' ? 'active' : ''}`} onClick={() => setTab('call')}>
          Call
        </div>
      </div>

      {tab === 'deploy' ? (
        <>
          <div className="form-row">
            <label htmlFor="source">AML Source Code</label>
            <textarea
              id="source"
              className="mono"
              rows={12}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="form-row">
            <label htmlFor="deploy-ou">Gas Fee (OU) — optional custom override</label>
            <input
              id="deploy-ou"
              className="mono"
              value={deployOu}
              onChange={(e) => setDeployOu(e.target.value.replace(/[^\d]/g, ''))}
              placeholder={recommendedOu('program_deploy', 0n)}
              inputMode="numeric"
            />
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {deployOu.trim()
                ? `Custom: ${deployFeeRaw} raw ≈ ${formatAmount(deployFeeRaw)} OCT`
                : `Default: ${recommendedOu('program_deploy', 0n)} raw ≈ ${formatAmount(
                    recommendedOu('program_deploy', 0n),
                  )} OCT`}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              type="password"
              className="mono"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button className="primary" onClick={requestDeploy} disabled={!source || !pin}>
              Compile & Deploy
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-row">
            <label htmlFor="addr">Contract Address</label>
            <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <input
                id="addr"
                className="mono"
                style={{ flex: 1 }}
                value={contractAddr}
                onChange={(e) => {
                  setContractAddr(e.target.value);
                  setMethodList([]);
                }}
                placeholder="oct..."
              />
              <button
                type="button"
                className="ghost"
                onClick={fetchMethods}
                disabled={!isValidAddress(contractAddr) || loadingMethods}
                title="Fetch callable methods from the contract ABI"
              >
                {loadingMethods ? <span className="spinner" /> : 'Fetch methods'}
              </button>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="method">Method Name</label>
            {methodList.length > 0 ? (
              <select
                id="method"
                className="mono"
                value={methodList.includes(method) ? method : '__custom__'}
                onChange={(e) => {
                  if (e.target.value === '__custom__') setMethod('');
                  else setMethod(e.target.value);
                }}
              >
                {methodList.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom__">✎ Custom…</option>
              </select>
            ) : (
              <input
                id="method"
                className="mono"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="transfer"
              />
            )}
            {methodList.length > 0 && !methodList.includes(method) && (
              <input
                className="mono"
                style={{ marginTop: 'var(--sp-2)' }}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="Enter custom method name"
              />
            )}
          </div>
          <div className="form-row">
            <label htmlFor="args">Arguments (JSON)</label>
            <textarea
              id="args"
              className="mono"
              rows={4}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="form-row">
            <label htmlFor="amt">Amount (OCT, sent with call)</label>
            <input
              id="amt"
              className="mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              inputMode="decimal"
            />
          </div>
          <div className="form-row">
            <label htmlFor="call-ou">Gas Fee (OU) — optional custom override</label>
            <input
              id="call-ou"
              className="mono"
              value={callOu}
              onChange={(e) => setCallOu(e.target.value.replace(/[^\d]/g, ''))}
              placeholder={recommendedOu('program_call', 0n)}
              inputMode="numeric"
            />
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {callOu.trim()
                ? `Custom: ${callFeeRaw} raw ≈ ${formatAmount(callFeeRaw)} OCT`
                : `Default: ${recommendedOu('program_call', 0n)} raw ≈ ${formatAmount(
                    recommendedOu('program_call', 0n),
                  )} OCT`}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="pin2">PIN</label>
            <input
              id="pin2"
              type="password"
              className="mono"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              className="primary"
              onClick={requestCall}
              disabled={!contractAddr || !method || !pin}
            >
              Sign & Call
            </button>
          </div>
        </>
      )}

      {result && (
        <div
          style={{ marginTop: 16, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 8 }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            Transaction Hash
          </div>
          <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {result}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmAction === 'deploy'}
        icon="📄"
        title="Confirm Contract Deploy"
        message="Deploying a contract compiles and broadcasts it to the network and incurs a network fee. This action cannot be undone."
        confirmLabel="Compile & Deploy"
        cancelLabel="Cancel"
        onConfirm={handleDeploy}
        onCancel={() => setConfirmAction(null)}
        details={[
          `Action:  Deploy contract`,
          `Fee:     ${formatAmount(deployFee)} OCT`,
          `Source:  ${source.length} chars`,
        ].join('\n')}
      />

      <ConfirmDialog
        open={confirmAction === 'call'}
        icon="📄"
        title="Confirm Contract Call"
        message="Calling a contract broadcasts a transaction and incurs a network fee, plus any amount you attach. This action cannot be undone."
        confirmLabel="Sign & Call"
        cancelLabel="Cancel"
        onConfirm={handleCall}
        onCancel={() => setConfirmAction(null)}
        details={[
          `Contract: ${contractAddr}`,
          `Method:   ${method}`,
          `Amount:   ${amount || '0'} OCT`,
          `Fee:      ${formatAmount(callFee)} OCT`,
        ].join('\n')}
      />
      <ProcessingModal
        open={panelLoading.loading}
        title={panelLoading.title}
        message={panelLoading.message}
        dismissible
        onClose={panelLoading.hide}
      />
    </div>
  );
}
