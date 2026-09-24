/**
 * termCoverageLexicon.ts — static vocabulary tables for the D1 term-coverage
 * signal (termCoverage.ts). Kept separate so the matching logic stays small
 * and the tables can be reviewed on their own.
 *
 * HONESTY NOTE (design doc §3.10.4): these tables are hand-written,
 * general-purpose software/ops vocabulary — not derived from any Lore
 * workspace and not generated from the recall-eval fixture. They WERE written
 * after reading the recall-eval dev-set misses (paraphrases such as
 * "callback" for webhook, "writeup" for postmortem, "command line" for CLI),
 * so some groups coincide with words in that dev set. The unseen validation
 * set written after tuning is the real test of whether they generalise.
 *
 * License: original work for groundfloor-lore.
 */

/** Conversational / question scaffolding that names no topic. Added on top
 *  of the shared keyword stopwords and termCoverage.ts's own list. */
export const CONVERSATIONAL_STOPWORDS: readonly string[] = [
    'hey', 'hi', 'hello', 'please', 'thanks', 'thank', 'remind', 'wonder', 'wondering', 'curious',
    'anymore', 'basically', 'stuff', 'anything', 'everything', 'someone', 'somebody', 'anyone',
    'okay', 'yeah', 'ago', 'back', 'lot', 'bit', 'again', 'maybe', 'probably', 'supposed',
    'remember', 'recall', 'mean', 'means', 'think', 'thought', 'seems', 'seem', 'guess',
];

/** Multi-word expressions folded to one token before term extraction, so
 *  "command line tool" can match a stored "CLI". Applied case-insensitively
 *  on word boundaries; `\s|-` between the words. */
export const PHRASE_FOLDS: ReadonlyArray<readonly [readonly string[], string]> = [
    [['command', 'line'], 'cli'],
    [['post', 'mortem'], 'postmortem'],
    [['write', 'up'], 'writeup'],
    [['time', 'to', 'live'], 'ttl'],
    [['dead', 'letter'], 'deadletter'],
    [['check', 'in'], 'checkin'],
    [['checking', 'in'], 'checkin'],
    [['sign', 'in'], 'signin'],
    [['log', 'in'], 'login'],
    [['roll', 'back'], 'rollback'],
    [['rate', 'limit'], 'ratelimit'],
    [['rate', 'limiting'], 'ratelimit'],
    [['round', 'robin'], 'roundrobin'],
];

/** Groups of near-synonyms common in software / operations writing. A query
 *  word counts as covered when ANY member of a group it belongs to occurs in
 *  the judged texts. Members are single tokens (compared by lightStem). A
 *  word may sit in more than one group. */
export const SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
    ['webhook', 'callback'],
    ['outbound', 'outgoing', 'egress'],
    ['inbound', 'incoming', 'ingress'],
    ['tenant', 'customer', 'client', 'account', 'organization', 'org'],
    ['user', 'person', 'people', 'individual'],
    ['authentication', 'authenticate', 'auth', 'login', 'signin', 'credential'],
    ['authorization', 'authorize', 'permission', 'access', 'acl', 'rbac'],
    ['signature', 'sign', 'signed', 'signing', 'hmac', 'authentication'],
    ['verify', 'verification', 'validate', 'validation'],
    ['postmortem', 'retrospective', 'retro', 'writeup', 'rca'],
    ['config', 'configuration', 'settings', 'setting', 'conf'],
    ['job', 'task'],
    ['machine', 'host', 'server', 'instance', 'vm'],
    ['delete', 'deletion', 'remove', 'removal', 'purge', 'erase', 'evict'],
    ['limit', 'cap', 'ceiling', 'max', 'maximum', 'quota', 'threshold'],
    ['minimum', 'min', 'floor'],
    ['error', 'failure', 'fail', 'fault', 'exception'],
    ['duration', 'ttl', 'timeout', 'period', 'interval', 'lifetime'],
    ['retry', 'reattempt', 'redeliver', 'redelivery', 'replay', 'resend'],
    ['message', 'event', 'payload', 'notification'],
    ['storage', 'store', 'persist', 'database', 'db', 'datastore'],
    ['crash', 'panic', 'stall', 'hang', 'freeze', 'stuck', 'deadlock', 'outage'],
    ['slow', 'latency', 'lag', 'delay'],
    ['big', 'large', 'huge', 'heavy', 'massive'],
    ['uneven', 'skew', 'skewed', 'imbalance', 'unbalanced', 'hotspot'],
    ['load', 'traffic', 'throughput', 'volume'],
    ['cli', 'commandline', 'terminal', 'shell'],
    ['monitoring', 'observability', 'telemetry', 'metrics', 'instrumentation'],
    ['deploy', 'deployment', 'release', 'rollout'],
    ['rollback', 'revert', 'undo'],
    ['secret', 'token', 'credential', 'password'],
    ['rotate', 'rotation', 'renew', 'renewal', 'refresh'],
    ['expire', 'expiry', 'expiration', 'ttl', 'valid', 'validity'],
    ['shard', 'partition'],
    ['deadletter', 'dlq', 'poison'],
    ['schedule', 'scheduler', 'timer'],
    ['duplicate', 'twice', 'double', 'dup', 'repeat', 'repeated'],
    ['idempotent', 'idempotency', 'dedupe', 'deduplication'],
    ['bug', 'defect', 'issue', 'problem', 'regression', 'incident'],
    ['fix', 'patch', 'workaround', 'remedy', 'resolution'],
    ['spike', 'burst', 'surge'],
    ['rewrite', 'reimplement', 'migrate', 'migration'],
    ['format', 'syntax', 'schema'],
    ['vendor', 'provider', 'saas', 'hosted'],
    ['api', 'endpoint'],
    ['worker', 'consumer', 'executor', 'runner'],
    ['lock', 'lease', 'claim', 'mutex'],
    ['heartbeat', 'ping', 'keepalive', 'checkin'],
    ['yaml', 'yml'],
    ['kubernetes', 'k8s'],
    ['postgres', 'postgresql'],
];

/** English number words → digits, so "thirty seconds" can match "30s". */
export const NUMBER_WORDS: Readonly<Record<string, string>> = {
    two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30', forty: '40', fifty: '50',
    sixty: '60', ninety: '90', hundred: '100', thousand: '1000',
};
