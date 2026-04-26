/**
 * ContextZero — Universal Language Adapter (tree-sitter)
 *
 * Production-grade multi-language symbol/relation/behavior/contract extraction
 * using tree-sitter for CST parsing. Supports TypeScript, JavaScript, Python,
 * C++, Go, Rust, Java, C#, and Ruby.
 *
 * Key design decisions:
 * - One shared BEHAVIOR_PATTERNS array (regex-based side-effect detection)
 * - Language-specific walkers for symbol/relation/contract extraction
 * - Stable keys: "relativePath::ParentClass.symbolName"
 * - SHA-256 hashing for ast_hash (s-expression), body_hash (raw text),
 *   and normalized_ast_hash (comments/whitespace stripped)
 * - Graceful degradation on parse errors with confidence scoring
 */

import * as crypto from 'crypto';
import { Logger } from '../../logger';
import type {
    AdapterExtractionResult,
    ExtractedSymbol,
    ExtractedRelation,
    BehaviorHint,
    ContractHint,
    StructuralRelationType,
} from '../../types';

// tree-sitter is a CommonJS native addon — must use require for native bindings
import type TSParser from 'tree-sitter';
type SyntaxNode = TSParser.SyntaxNode;
type TreeSitterTree = TSParser.Tree;
type TreeSitterLanguage = TSParser.Language;
/* eslint-disable @typescript-eslint/no-require-imports */
const Parser = require('tree-sitter');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'cpp' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby' | 'kotlin' | 'swift' | 'php' | 'bash';

// ---------------------------------------------------------------------------
// Grammar loading (lazy, cached)
// ---------------------------------------------------------------------------

const grammarCache = new Map<SupportedLanguage, TreeSitterLanguage>();

function getGrammar(language: SupportedLanguage): TreeSitterLanguage {
    if (grammarCache.has(language)) return grammarCache.get(language)!;

    let grammar: TreeSitterLanguage;
    try {
    switch (language) {
        case 'typescript': {
            // tree-sitter-typescript exports .typescript and .tsx sub-grammars
            const tsLangs = require('tree-sitter-typescript');
            grammar = tsLangs.typescript;
            break;
        }
        case 'javascript': {
            // tree-sitter-typescript depends on tree-sitter-javascript
            // The typescript grammar can parse JS; alternatively we can use its
            // tsx sub-grammar which is a superset. However, for maximum fidelity
            // we use the typescript sub-grammar (it handles JS fine).
            const tsLangs = require('tree-sitter-typescript');
            grammar = tsLangs.typescript;
            break;
        }
        case 'python':
            grammar = require('tree-sitter-python');
            break;
        case 'cpp':
            grammar = require('tree-sitter-cpp');
            break;
        case 'go':
            grammar = require('tree-sitter-go');
            break;
        case 'rust':
            grammar = require('tree-sitter-rust');
            break;
        case 'java':
            grammar = require('tree-sitter-java');
            break;
        case 'csharp':
            grammar = require('tree-sitter-c-sharp');
            break;
        case 'ruby':
            grammar = require('tree-sitter-ruby');
            break;
        case 'kotlin':
            grammar = require('tree-sitter-kotlin');
            break;
        case 'swift':
            grammar = require('tree-sitter-swift');
            break;
        case 'php': {
            const phpGrammar = require('tree-sitter-php');
            // tree-sitter-php exports .php and .php_only sub-grammars
            grammar = phpGrammar.php || phpGrammar;
            break;
        }
        case 'bash':
            grammar = require('tree-sitter-bash');
            break;
        default:
            throw new Error(`Unsupported language: ${language}`);
    }
    } catch (err) {
        throw new Error(`Failed to load grammar for ${language}: ${err instanceof Error ? err.message : String(err)}. The tree-sitter grammar package may need to be rebuilt for your platform.`);
    }

    grammarCache.set(language, grammar);
    return grammar;
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Parser pool (one parser per language, reused)
// ---------------------------------------------------------------------------

const parserCache = new Map<SupportedLanguage, TSParser>();

function getParser(language: SupportedLanguage): TSParser {
    if (parserCache.has(language)) return parserCache.get(language)!;
    const parser = new Parser();
    parser.setLanguage(getGrammar(language));
    parserCache.set(language, parser);
    return parser;
}

// ---------------------------------------------------------------------------
// Behavior patterns — shared across all languages
// ---------------------------------------------------------------------------

interface BehaviorPattern {
    pattern: RegExp;
    hint_type: BehaviorHint['hint_type'];
    detail: string;
    /** If set, only match this pattern for these languages. If undefined, matches all languages. */
    languages?: SupportedLanguage[];
}

const BEHAVIOR_PATTERNS: BehaviorPattern[] = [
    // DB reads — patterns require ORM-like context to avoid false positives
    // e.g., "repository.findOne()" matches, but "array.find()" does not
    { pattern: /\.(findOne|findMany|findAll|findById|findUnique|findFirst)\s*\(/, hint_type: 'db_read', detail: 'orm_find' },
    { pattern: /\.select\s*\(/, hint_type: 'db_read', detail: 'query_select' },
    { pattern: /\.query\s*\(/, hint_type: 'db_read', detail: 'raw_query' },
    { pattern: /\.(getOne|getMany|getAll|getById)\s*\(/, hint_type: 'db_read', detail: 'db_get' },
    // DB writes — tightened to ORM-specific method names to avoid matching
    // crypto.createHash().update(), canvas.save(), array.splice() etc.
    { pattern: /\.(persist|saveAll|saveMany)\s*\(/, hint_type: 'db_write', detail: 'orm_save' },
    { pattern: /\.(insertOne|insertMany|bulkInsert|batchInsert)\s*\(/, hint_type: 'db_write', detail: 'db_insert' },
    { pattern: /\.(updateOne|updateMany|updateById|bulkUpdate)\s*\(/, hint_type: 'db_write', detail: 'db_update' },
    { pattern: /\.(deleteOne|deleteMany|deleteById|bulkDelete)\s*\(/, hint_type: 'db_write', detail: 'db_delete' },
    { pattern: /\.(removeOne|removeMany|removeById)\s*\(/, hint_type: 'db_write', detail: 'db_remove' },
    { pattern: /\.(createOne|createMany|bulkCreate)\s*\(/, hint_type: 'db_write', detail: 'db_create' },
    // DB writes — context-aware patterns (require db/repository/model receiver)
    { pattern: /\b(db|DB|repo|repository|model|Model|collection|Collection|table|Table)\.\w*(save|insert|update|delete|remove|create|upsert|destroy)\w*\s*\(/, hint_type: 'db_write', detail: 'db_contextual_write' },
    // Network calls
    { pattern: /fetch\s*\(/, hint_type: 'network_call', detail: 'fetch' },
    { pattern: /axios\.(get|post|put|patch|delete)\s*\(/, hint_type: 'network_call', detail: 'axios' },
    { pattern: /\.request\s*\(/, hint_type: 'network_call', detail: 'http_request' },
    { pattern: /https?\.\s*(get|request)\s*\(/, hint_type: 'network_call', detail: 'node_http' },
    { pattern: /WebSocket/, hint_type: 'network_call', detail: 'websocket' },
    // File I/O
    { pattern: /fs\.(read|write|append|unlink|mkdir|rmdir)/, hint_type: 'file_io', detail: 'fs_operation' },
    { pattern: /readFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'read_file' },
    { pattern: /writeFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'write_file' },
    { pattern: /\bopen\s*\(/, hint_type: 'file_io', detail: 'file_open', languages: ['python', 'ruby'] },
    // Cache
    { pattern: /\.cache\.(get|set|del|clear)/, hint_type: 'cache_op', detail: 'cache_operation' },
    { pattern: /redis\.(get|set|hget|hset|del)/, hint_type: 'cache_op', detail: 'redis' },
    // Auth
    { pattern: /\.authenticate\s*\(/, hint_type: 'auth_check', detail: 'authenticate' },
    { pattern: /\.authorize\s*\(/, hint_type: 'auth_check', detail: 'authorize' },
    { pattern: /verify(Token|JWT|Session)/, hint_type: 'auth_check', detail: 'token_verify' },
    { pattern: /\.isAuthenticated/, hint_type: 'auth_check', detail: 'auth_check' },
    // Validation
    { pattern: /\.validate\s*\(/, hint_type: 'validation', detail: 'validate' },
    { pattern: /Joi\.|Yup\.|Zod\./, hint_type: 'validation', detail: 'schema_validation' },
    // Exceptions
    { pattern: /throw\s+new\s+\w+/, hint_type: 'throws', detail: 'throws' },
    { pattern: /raise\s+\w+/, hint_type: 'throws', detail: 'python_raise' },
    { pattern: /catch\s*\(/, hint_type: 'catches', detail: 'catches' },
    { pattern: /except\s+/, hint_type: 'catches', detail: 'python_except' },
    // State mutation
    { pattern: /this\.\w+\s*=/, hint_type: 'state_mutation', detail: 'this_assignment' },
    { pattern: /self\.\w+\s*=/, hint_type: 'state_mutation', detail: 'self_assignment' },
    { pattern: /\.setState\s*\(/, hint_type: 'state_mutation', detail: 'set_state' },
    // Transactions
    { pattern: /\.transaction\s*\(/, hint_type: 'transaction', detail: 'db_transaction' },
    { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: 'transaction', detail: 'sql_transaction' },
    // Logging
    { pattern: /console\.(log|warn|error|info)/, hint_type: 'logging', detail: 'console' },
    { pattern: /log\.(debug|info|warn|error|fatal)/, hint_type: 'logging', detail: 'structured_log' },
    { pattern: /logging\.(debug|info|warn|error)/, hint_type: 'logging', detail: 'python_logging' },
    { pattern: /fmt\.(Print|Println|Printf|Errorf)/, hint_type: 'logging', detail: 'go_fmt' },
    { pattern: /std::cout|std::cerr|fprintf/, hint_type: 'logging', detail: 'cpp_io' },

    // --- Rust patterns (language-gated) ---
    { pattern: /tokio::spawn/, hint_type: 'concurrency', detail: 'tokio_spawn', languages: ['rust'] },
    { pattern: /reqwest::(get|post|put|patch|delete|Client)/, hint_type: 'network_call', detail: 'reqwest', languages: ['rust'] },
    { pattern: /hyper::(Client|Request|Response)/, hint_type: 'network_call', detail: 'hyper', languages: ['rust'] },
    { pattern: /std::fs::/, hint_type: 'file_io', detail: 'rust_fs', languages: ['rust'] },
    { pattern: /File::(open|create)/, hint_type: 'file_io', detail: 'rust_file', languages: ['rust'] },
    { pattern: /diesel::/, hint_type: 'db_read', detail: 'diesel', languages: ['rust'] },
    { pattern: /sqlx::/, hint_type: 'db_read', detail: 'sqlx', languages: ['rust'] },
    { pattern: /sea_orm::/, hint_type: 'db_read', detail: 'sea_orm', languages: ['rust'] },
    { pattern: /\.execute\s*\(/, hint_type: 'db_write', detail: 'db_execute', languages: ['rust', 'java'] },
    { pattern: /serde_json::/, hint_type: 'serialization', detail: 'serde_json', languages: ['rust'] },
    { pattern: /serde::/, hint_type: 'serialization', detail: 'serde', languages: ['rust'] },
    { pattern: /log::(debug|info|warn|error|trace)/, hint_type: 'logging', detail: 'rust_log', languages: ['rust'] },
    { pattern: /tracing::(debug|info|warn|error|trace|span)/, hint_type: 'logging', detail: 'rust_tracing', languages: ['rust'] },
    { pattern: /Arc::new/, hint_type: 'concurrency', detail: 'arc_shared_state', languages: ['rust'] },
    { pattern: /Mutex::(lock|try_lock)/, hint_type: 'acquires_lock', detail: 'rust_mutex', languages: ['rust'] },
    { pattern: /RwLock::(read|write)/, hint_type: 'acquires_lock', detail: 'rust_rwlock', languages: ['rust'] },
    { pattern: /panic!/, hint_type: 'throws', detail: 'rust_panic', languages: ['rust'] },
    { pattern: /\.unwrap\s*\(/, hint_type: 'throws', detail: 'rust_unwrap', languages: ['rust'] },
    { pattern: /\.expect\s*\(/, hint_type: 'throws', detail: 'rust_expect', languages: ['rust'] },
    { pattern: /unsafe\s*\{/, hint_type: 'state_mutation', detail: 'unsafe_block', languages: ['rust'] },

    // --- Java patterns (language-gated) ---
    { pattern: /jdbc|DriverManager\.getConnection/, hint_type: 'db_read', detail: 'jdbc', languages: ['java'] },
    { pattern: /EntityManager|@PersistenceContext/, hint_type: 'db_read', detail: 'jpa', languages: ['java'] },
    { pattern: /Hibernate|SessionFactory|Session\./, hint_type: 'db_read', detail: 'hibernate', languages: ['java'] },
    { pattern: /MyBatis|SqlSession/, hint_type: 'db_read', detail: 'mybatis', languages: ['java'] },
    { pattern: /HttpClient\.new/, hint_type: 'network_call', detail: 'java_httpclient', languages: ['java'] },
    { pattern: /OkHttpClient|okhttp3/, hint_type: 'network_call', detail: 'okhttp', languages: ['java'] },
    { pattern: /RestTemplate|WebClient/, hint_type: 'network_call', detail: 'spring_http', languages: ['java'] },
    { pattern: /Files\.(read|write|copy|move|delete|create)/, hint_type: 'file_io', detail: 'java_nio_files', languages: ['java'] },
    { pattern: /FileInputStream|FileOutputStream|FileReader|FileWriter/, hint_type: 'file_io', detail: 'java_file_io', languages: ['java'] },
    { pattern: /Jedis|Lettuce|RedisTemplate/, hint_type: 'cache_op', detail: 'java_redis', languages: ['java'] },
    { pattern: /@Transactional/, hint_type: 'transaction', detail: 'spring_transactional', languages: ['java'] },
    { pattern: /synchronized\s*\(/, hint_type: 'acquires_lock', detail: 'java_synchronized', languages: ['java'] },
    { pattern: /ReentrantLock|\.lock\s*\(/, hint_type: 'acquires_lock', detail: 'java_lock', languages: ['java'] },
    { pattern: /Logger\.(debug|info|warn|error|trace)/, hint_type: 'logging', detail: 'java_logger', languages: ['java'] },
    { pattern: /LOG\.(debug|info|warn|error|trace)/, hint_type: 'logging', detail: 'java_LOG', languages: ['java'] },
    { pattern: /throw\s+new\s+/, hint_type: 'throws', detail: 'java_throw', languages: ['java'] },

    // --- C# patterns (language-gated) ---
    { pattern: /DbContext|DbSet|EntityFramework/, hint_type: 'db_read', detail: 'ef_core', languages: ['csharp'] },
    { pattern: /\.SaveChanges(Async)?\s*\(/, hint_type: 'db_write', detail: 'ef_save_changes', languages: ['csharp'] },
    { pattern: /HttpClient\.(Get|Post|Put|Delete|Send)/, hint_type: 'network_call', detail: 'csharp_httpclient', languages: ['csharp'] },
    { pattern: /WebRequest|HttpWebRequest/, hint_type: 'network_call', detail: 'csharp_webrequest', languages: ['csharp'] },
    { pattern: /File\.(Read|Write|Open|Create|Delete|Copy|Move)/, hint_type: 'file_io', detail: 'csharp_file', languages: ['csharp'] },
    { pattern: /Stream(Reader|Writer)/, hint_type: 'file_io', detail: 'csharp_stream', languages: ['csharp'] },
    { pattern: /lock\s*\(/, hint_type: 'acquires_lock', detail: 'csharp_lock', languages: ['csharp'] },
    { pattern: /SemaphoreSlim|Monitor\.(Enter|Exit)/, hint_type: 'acquires_lock', detail: 'csharp_semaphore', languages: ['csharp'] },
    { pattern: /ILogger\.(Log|Debug|Info|Warn|Error)/, hint_type: 'logging', detail: 'csharp_ilogger', languages: ['csharp'] },
    { pattern: /Debug\.(Write|WriteLine)/, hint_type: 'logging', detail: 'csharp_debug', languages: ['csharp'] },
    { pattern: /Trace\.(Write|WriteLine)/, hint_type: 'logging', detail: 'csharp_trace', languages: ['csharp'] },

    // --- Ruby patterns (language-gated) ---
    { pattern: /ActiveRecord|ApplicationRecord/, hint_type: 'db_read', detail: 'activerecord', languages: ['ruby'] },
    { pattern: /\.where\s*\(/, hint_type: 'db_read', detail: 'ar_where', languages: ['ruby'] },
    { pattern: /\.find(_by)?\s*\(/, hint_type: 'db_read', detail: 'ar_find', languages: ['ruby'] },
    { pattern: /\.create[!]?\s*\(/, hint_type: 'db_write', detail: 'ar_create', languages: ['ruby'] },
    { pattern: /\.update[!]?\s*\(/, hint_type: 'db_write', detail: 'ar_update', languages: ['ruby'] },
    { pattern: /\.destroy[!]?\s*\(/, hint_type: 'db_write', detail: 'ar_destroy', languages: ['ruby'] },
    { pattern: /Net::HTTP/, hint_type: 'network_call', detail: 'ruby_net_http', languages: ['ruby'] },
    { pattern: /HTTParty/, hint_type: 'network_call', detail: 'httparty', languages: ['ruby'] },
    { pattern: /Faraday/, hint_type: 'network_call', detail: 'faraday', languages: ['ruby'] },
    { pattern: /RestClient/, hint_type: 'network_call', detail: 'rest_client', languages: ['ruby'] },
    { pattern: /File\.(open|read|write|delete)/, hint_type: 'file_io', detail: 'ruby_file', languages: ['ruby'] },
    { pattern: /IO\.(read|write|foreach)/, hint_type: 'file_io', detail: 'ruby_io', languages: ['ruby'] },
    { pattern: /Rails\.cache/, hint_type: 'cache_op', detail: 'rails_cache', languages: ['ruby'] },
    { pattern: /Redis\.(new|current)/, hint_type: 'cache_op', detail: 'ruby_redis', languages: ['ruby'] },
    { pattern: /raise\s+/, hint_type: 'throws', detail: 'ruby_raise', languages: ['ruby', 'python'] },
    { pattern: /rescue\s+/, hint_type: 'catches', detail: 'ruby_rescue', languages: ['ruby'] },
    { pattern: /attr_(accessor|reader|writer)/, hint_type: 'state_mutation', detail: 'ruby_attr', languages: ['ruby'] },
    { pattern: /Rails\.logger/, hint_type: 'logging', detail: 'rails_logger', languages: ['ruby'] },

    // --- Go additional patterns (language-gated) ---
    { pattern: /go\s+func/, hint_type: 'concurrency', detail: 'goroutine', languages: ['go'] },
    { pattern: /make\s*\(\s*chan\s/, hint_type: 'concurrency', detail: 'go_channel_create', languages: ['go'] },
    { pattern: /<-\s*\w+/, hint_type: 'concurrency', detail: 'go_channel_recv', languages: ['go'] },
    { pattern: /http\.(Get|Post|Head|NewRequest)/, hint_type: 'network_call', detail: 'go_http', languages: ['go'] },
    { pattern: /sql\.Open/, hint_type: 'db_read', detail: 'go_sql_open', languages: ['go'] },
    { pattern: /os\.(Open|Create|ReadFile|WriteFile)/, hint_type: 'file_io', detail: 'go_os_file', languages: ['go'] },
    { pattern: /sync\.(Mutex|RWMutex|WaitGroup)/, hint_type: 'acquires_lock', detail: 'go_sync', languages: ['go'] },

    // --- C++ additional patterns (language-gated) ---
    { pattern: /std::thread/, hint_type: 'concurrency', detail: 'cpp_thread', languages: ['cpp'] },
    { pattern: /std::mutex|std::lock_guard|std::unique_lock/, hint_type: 'acquires_lock', detail: 'cpp_mutex', languages: ['cpp'] },
    { pattern: /std::(i|o)?fstream|std::ifstream|std::ofstream/, hint_type: 'file_io', detail: 'cpp_fstream', languages: ['cpp'] },
    { pattern: /boost::asio/, hint_type: 'network_call', detail: 'boost_asio', languages: ['cpp'] },

    // --- Python additional patterns (language-gated) ---
    { pattern: /asyncio\.(run|gather|create_task|ensure_future)/, hint_type: 'concurrency', detail: 'python_asyncio', languages: ['python'] },
    { pattern: /aiohttp\.(ClientSession|request)/, hint_type: 'network_call', detail: 'python_aiohttp', languages: ['python'] },
    { pattern: /sqlalchemy/, hint_type: 'db_read', detail: 'sqlalchemy', languages: ['python'] },
    { pattern: /FastAPI|APIRouter/, hint_type: 'network_call', detail: 'fastapi', languages: ['python'] },
    { pattern: /httpx\.(get|post|put|delete|AsyncClient)/, hint_type: 'network_call', detail: 'python_httpx', languages: ['python'] },

    // --- Kotlin patterns (language-gated) ---
    { pattern: /\b(launch|async|runBlocking|withContext|Dispatchers)\b/, hint_type: 'concurrency', detail: 'kotlin_coroutine', languages: ['kotlin'] },
    { pattern: /\bRetrofit|OkHttpClient|HttpClient\b/, hint_type: 'network_call', detail: 'kotlin_http', languages: ['kotlin'] },
    { pattern: /\b(Room|Exposed|Hibernate|JpaRepository)\b/, hint_type: 'db_read', detail: 'kotlin_orm', languages: ['kotlin'] },
    { pattern: /\bFile\.(readText|writeText|readLines|readBytes)\b/, hint_type: 'file_io', detail: 'kotlin_file', languages: ['kotlin'] },
    { pattern: /\b@Transactional\b/, hint_type: 'transaction', detail: 'kotlin_transaction', languages: ['kotlin'] },
    { pattern: /\bsynchronized\s*\(/, hint_type: 'acquires_lock', detail: 'kotlin_synchronized', languages: ['kotlin'] },
    { pattern: /\bMutex\b/, hint_type: 'acquires_lock', detail: 'kotlin_mutex', languages: ['kotlin'] },

    // --- Swift patterns (language-gated) ---
    { pattern: /\bTask\s*\{|async\s+let\b/, hint_type: 'concurrency', detail: 'swift_structured_concurrency', languages: ['swift'] },
    { pattern: /\bURLSession\.(shared|data|download|upload)\b/, hint_type: 'network_call', detail: 'swift_urlsession', languages: ['swift'] },
    { pattern: /\bAlamofire\b/, hint_type: 'network_call', detail: 'swift_alamofire', languages: ['swift'] },
    { pattern: /\bCoreData|NSManagedObject|NSPersistentContainer\b/, hint_type: 'db_read', detail: 'swift_coredata', languages: ['swift'] },
    { pattern: /\bFileManager\.(default|copyItem|moveItem|removeItem|createFile)\b/, hint_type: 'file_io', detail: 'swift_filemanager', languages: ['swift'] },
    { pattern: /\bUserDefaults\b/, hint_type: 'cache_op', detail: 'swift_userdefaults', languages: ['swift'] },
    { pattern: /\bos_unfair_lock|NSLock|DispatchSemaphore\b/, hint_type: 'acquires_lock', detail: 'swift_lock', languages: ['swift'] },

    // --- PHP patterns (language-gated) ---
    { pattern: /\b(PDO|mysqli|pg_query|pg_connect)\b/, hint_type: 'db_read', detail: 'php_db', languages: ['php'] },
    { pattern: /\bEloquent|DB::table|DB::select|Model::(find|where|all)\b/, hint_type: 'db_read', detail: 'php_eloquent', languages: ['php'] },
    { pattern: /\b(->save|->create|->update|->delete|->destroy)\s*\(/, hint_type: 'db_write', detail: 'php_eloquent_write', languages: ['php'] },
    { pattern: /\bcurl_init|Guzzle|Http::get|Http::post\b/, hint_type: 'network_call', detail: 'php_http', languages: ['php'] },
    { pattern: /\b(fopen|fwrite|fread|file_get_contents|file_put_contents)\b/, hint_type: 'file_io', detail: 'php_file', languages: ['php'] },
    { pattern: /\bCache::(get|put|forget|remember)\b/, hint_type: 'cache_op', detail: 'php_cache', languages: ['php'] },
    { pattern: /\bRedis::(get|set|del)\b/, hint_type: 'cache_op', detail: 'php_redis', languages: ['php'] },
    { pattern: /\bAuth::(check|user|attempt|login|logout)\b/, hint_type: 'auth_check', detail: 'php_auth', languages: ['php'] },
    { pattern: /\bDB::beginTransaction|DB::commit|DB::rollBack\b/, hint_type: 'transaction', detail: 'php_transaction', languages: ['php'] },
    { pattern: /\bLog::(info|debug|warning|error|critical)\b/, hint_type: 'logging', detail: 'php_log', languages: ['php'] },

    // --- Bash patterns (language-gated) ---
    { pattern: /\bcurl\s/, hint_type: 'network_call', detail: 'bash_curl', languages: ['bash'] },
    { pattern: /\bwget\s/, hint_type: 'network_call', detail: 'bash_wget', languages: ['bash'] },
    { pattern: /\b(cat|head|tail|grep|awk|sed)\s/, hint_type: 'file_io', detail: 'bash_file_read', languages: ['bash'] },
    { pattern: /\b(echo|printf)\s.*>>?\s/, hint_type: 'file_io', detail: 'bash_file_write', languages: ['bash'] },
    { pattern: /\brm\s+-/, hint_type: 'file_io', detail: 'bash_rm', languages: ['bash'] },
    { pattern: /\b(mysql|psql|sqlite3|mongosh)\s/, hint_type: 'db_read', detail: 'bash_db_cli', languages: ['bash'] },
    { pattern: /\bsudo\s/, hint_type: 'auth_check', detail: 'bash_sudo', languages: ['bash'] },
    { pattern: /\bflock\s/, hint_type: 'acquires_lock', detail: 'bash_flock', languages: ['bash'] },

    // --- Serialization (cross-language) ---
    { pattern: /JSON\.(parse|stringify)/, hint_type: 'serialization', detail: 'json' },
    { pattern: /json\.(dumps|loads|dump|load)/, hint_type: 'serialization', detail: 'python_json' },
    { pattern: /Jackson|ObjectMapper/, hint_type: 'serialization', detail: 'jackson' },
    { pattern: /Gson/, hint_type: 'serialization', detail: 'gson' },
    { pattern: /json\.Marshal|json\.Unmarshal/, hint_type: 'serialization', detail: 'go_json' },
    { pattern: /Newtonsoft|JsonConvert|System\.Text\.Json/, hint_type: 'serialization', detail: 'csharp_json' },
];

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute a normalized AST hash by stripping comments and collapsing whitespace.
 * Language-aware: only strips `#` as comments for languages where `#` is a comment character.
 */
function computeNormalizedAstHash(text: string, language?: SupportedLanguage): string {
    let normalized = text;
    // Remove single-line comments (//)
    normalized = normalized.replace(/\/\/[^\n]*/g, '');
    // Only strip # comments for languages where # is a comment character
    const hashCommentLanguages: SupportedLanguage[] = ['python', 'ruby'];
    if (language && hashCommentLanguages.includes(language)) {
        normalized = normalized.replace(/#[^\n]*/g, '');
    }
    // Remove multi-line comments (/* ... */ and """ ... """)
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
    normalized = normalized.replace(/"""[\s\S]*?"""/g, '');
    normalized = normalized.replace(/'''[\s\S]*?'''/g, '');
    // Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return sha256(normalized);
}

/**
 * Find the name identifier of a tree-sitter node. Different languages use
 * different field names ('name', 'declarator', etc.).
 */
function getNodeName(node: SyntaxNode, language: SupportedLanguage): string | null {
    // Direct 'name' field — most common
    const nameChild = node.childForFieldName('name');
    if (nameChild) {
        // In C++ the name field might be a qualified_identifier or destructor_name
        if (nameChild.type === 'identifier' || nameChild.type === 'type_identifier' ||
            nameChild.type === 'field_identifier' || nameChild.type === 'property_identifier') {
            return nameChild.text;
        }
        // For qualified identifiers, destructor names, etc., use the text
        return nameChild.text;
    }

    // C++ function_definition: the declarator field holds the name
    if (language === 'cpp') {
        const declarator = node.childForFieldName('declarator');
        if (declarator) {
            return extractCppDeclaratorName(declarator);
        }
    }

    // Kotlin/Swift: some grammars don't use 'name' field — look for identifier children
    // Kotlin uses simple_identifier, Swift uses identifier, etc.
    for (let i = 0; i < Math.min(node.namedChildCount, 5); i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'simple_identifier' || child.type === 'type_identifier' ||
            child.type === 'word') {
            return child.text;
        }
    }

    return null;
}

/**
 * Recursively dig into C++ declarators to find the actual identifier.
 * Handles: function_declarator -> identifier, reference_declarator,
 * pointer_declarator, qualified_identifier, etc.
 */
function extractCppDeclaratorName(node: SyntaxNode): string | null {
    if (!node) return null;
    if (node.type === 'identifier' || node.type === 'field_identifier' ||
        node.type === 'type_identifier') {
        return node.text;
    }
    if (node.type === 'destructor_name') {
        return '~' + (node.namedChildren[0]?.text ?? '');
    }
    if (node.type === 'qualified_identifier') {
        // Return the full qualified name
        return node.text;
    }
    // function_declarator -> declarator field holds the name
    const inner = node.childForFieldName('declarator');
    if (inner) return extractCppDeclaratorName(inner);
    // Try the name field
    const nameField = node.childForFieldName('name');
    if (nameField) return extractCppDeclaratorName(nameField);
    // Fallback: first named child
    const firstChild = node.namedChild(0);
    if (firstChild) {
        return extractCppDeclaratorName(firstChild);
    }
    return node.text?.trim() || null;
}

// ---------------------------------------------------------------------------
// Full call-chain extraction
// ---------------------------------------------------------------------------

/**
 * Walk a member_expression / attribute / field_expression / selector_expression
 * tree to build the full dotted call path.
 *
 * e.g. self.service.repository.find() → "self.service.repository.find"
 *      Namespace::Class::method()     → "Namespace::Class::method"
 *      model->layer->forward()        → "model.layer.forward"
 */
function extractFullCallChain(node: SyntaxNode, language: SupportedLanguage): string {
    if (!node) return '';

    switch (node.type) {
        case 'identifier':
        case 'field_identifier':
        case 'property_identifier':
        case 'type_identifier':
        case 'constant':
            return node.text;

        case 'self':
        case 'this':
            return node.text;

        case 'member_expression':
        case 'property_access_expression': {
            // JS/TS: object.property
            const obj = node.childForFieldName('object');
            const prop = node.childForFieldName('property');
            const objChain = obj ? extractFullCallChain(obj, language) : '';
            const propName = prop ? prop.text : '';
            return objChain ? `${objChain}.${propName}` : propName;
        }

        case 'subscript_expression': {
            // Treat array access as part of chain
            const obj = node.childForFieldName('object');
            return obj ? extractFullCallChain(obj, language) : node.text;
        }

        case 'attribute': {
            // Python: object.attribute
            const obj = node.childForFieldName('object');
            const attr = node.childForFieldName('attribute');
            const objChain = obj ? extractFullCallChain(obj, language) : '';
            const attrName = attr ? attr.text : '';
            return objChain ? `${objChain}.${attrName}` : attrName;
        }

        case 'selector_expression': {
            // Go: object.Field
            const operand = node.childForFieldName('operand');
            const field = node.childForFieldName('field');
            const opChain = operand ? extractFullCallChain(operand, language) : '';
            const fieldName = field ? field.text : '';
            return opChain ? `${opChain}.${fieldName}` : fieldName;
        }

        case 'field_expression': {
            // Rust/C++: object.field or object->field
            const value = node.childForFieldName('value');
            const field = node.childForFieldName('field');
            const valChain = value ? extractFullCallChain(value, language) : '';
            const fieldName = field ? field.text : '';
            return valChain ? `${valChain}.${fieldName}` : fieldName;
        }

        case 'scoped_identifier':
        case 'qualified_identifier': {
            // Rust: path::to::item, C++: ns::func — normalize to dot notation
            return node.text.replace(/::/g, '.');
        }

        case 'scope_resolution': {
            // C#: Namespace.Class
            return node.text;
        }

        case 'member_access_expression': {
            // C#: object.member
            const expr = node.childForFieldName('expression');
            const name = node.childForFieldName('name');
            const exprChain = expr ? extractFullCallChain(expr, language) : '';
            const memberName = name ? name.text : '';
            return exprChain ? `${exprChain}.${memberName}` : memberName;
        }

        case 'method_reference':
        case 'call': {
            // Ruby: receiver.method
            const recv = node.childForFieldName('receiver');
            const method = node.childForFieldName('method');
            const recvChain = recv ? extractFullCallChain(recv, language) : '';
            const methodName = method ? method.text : '';
            return recvChain ? `${recvChain}.${methodName}` : methodName;
        }

        case 'method_call_expression': {
            // Rust: receiver.method(args) — extract receiver chain + method name
            // Children: field_expression/identifier (receiver), identifier (method), arguments
            const receiver = node.namedChild(0);
            const methodNameNode = node.namedChild(1);
            if (receiver && methodNameNode && methodNameNode.type === 'identifier') {
                const receiverChain = extractFullCallChain(receiver, language);
                return receiverChain ? `${receiverChain}.${methodNameNode.text}` : methodNameNode.text;
            }
            // Fallback: try field names
            const fieldExpr = node.childForFieldName('value') || node.namedChild(0);
            const methodId = node.childForFieldName('method') || node.namedChild(1);
            if (fieldExpr && methodId) {
                const chain = extractFullCallChain(fieldExpr, language);
                return chain ? `${chain}.${methodId.text}` : methodId.text;
            }
            return node.namedChild(0)?.text || '';
        }

        case 'macro_invocation': {
            // Rust: macro_name!(args) — extract macro name for call tracking
            const macroNode = node.childForFieldName('macro') || node.namedChild(0);
            if (macroNode) {
                const chain = extractFullCallChain(macroNode, language);
                return chain ? `${chain}!` : `${macroNode.text}!`;
            }
            return '';
        }

        default:
            return node.text || '';
    }
}

// ---------------------------------------------------------------------------
// Leading-comment extraction (for symbol summaries)
// ---------------------------------------------------------------------------

const COMMENT_NODE_TYPES = new Set(['comment', 'line_comment', 'block_comment']);

/**
 * Walk backwards from a node to collect leading comment text.
 * Handles JSDoc/Doxygen/Python docstring-style comments that immediately
 * precede a declaration.
 */
function extractLeadingComment(node: SyntaxNode, source: string): string | undefined {
    // Strategy 1: previousNamedSibling — works for most tree-sitter grammars
    let sibling = node.previousNamedSibling;

    // If the node is inside an export_statement, check the export's previous sibling
    if (!sibling && node.parent?.type === 'export_statement') {
        sibling = node.parent.previousNamedSibling;
    }

    if (sibling && COMMENT_NODE_TYPES.has(sibling.type)) {
        return cleanCommentText(sibling.text);
    }

    // Strategy 2: scan backwards in source from node start for comment block
    const startByte = node.parent?.type === 'export_statement'
        ? node.parent.startIndex
        : node.startIndex;
    const preceding = source.slice(Math.max(0, startByte - 2048), startByte);
    const trimmed = preceding.trimEnd();
    if (!trimmed) return undefined;

    // Match block comment ending right before the node
    const blockMatch = trimmed.match(/\/\*\*?([\s\S]*?)\*\/\s*$/);
    if (blockMatch) return cleanCommentText(blockMatch[0]);

    // Match consecutive line comments ending right before the node
    const lines = trimmed.split('\n');
    const commentLines: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim();
        if (line.startsWith('//') || line.startsWith('#')) {
            commentLines.unshift(line);
        } else if (line === '') {
            // Allow one blank line between comment block and declaration
            if (commentLines.length > 0) break;
        } else {
            break;
        }
    }
    if (commentLines.length > 0) return cleanCommentText(commentLines.join('\n'));

    return undefined;
}

/**
 * Strip comment delimiters and leading asterisks, collapse to a clean summary.
 */
function cleanCommentText(raw: string): string | undefined {
    let text = raw
        .replace(/^\/\*\*?\s*/, '')   // opening /* or /**
        .replace(/\*\/\s*$/, '')       // closing */
        .replace(/^\/\/\s?/gm, '')     // line comment markers
        .replace(/^#\s?/gm, '')        // Python comment markers
        .replace(/^\s*\*\s?/gm, '');   // leading * in block comments

    text = text.trim();
    if (!text) return undefined;

    // Take first paragraph only (before first blank line)
    const firstParagraph = text.split(/\n\s*\n/)[0];
    if (firstParagraph) text = firstParagraph.trim();

    // Cap at 512 chars to avoid storing huge comments
    if (text.length > 512) text = text.slice(0, 509) + '...';

    return text || undefined;
}

/**
 * Build a stable key from file path, optional parent name, and symbol name.
 * Format: "filePath::Parent.name" or "filePath::name"
 */
function makeStableKey(filePath: string, parentName: string | null, name: string): string {
    if (parentName) {
        return `${filePath}::${parentName}.${name}`;
    }
    return `${filePath}::${name}`;
}

// ---------------------------------------------------------------------------
// Visibility detection
// ---------------------------------------------------------------------------

function detectVisibility(node: SyntaxNode, source: string, language: SupportedLanguage, parentNode: SyntaxNode | null): string {
    const text = node.text as string;
    switch (language) {
        case 'typescript':
        case 'javascript': {
            // Check for export keyword: look at parent or previous sibling
            const parent = node.parent;
            if (parent) {
                if (parent.type === 'export_statement') return 'public';
                // `export default`
                if (parent.type === 'export_statement' || parent.type === 'export_declaration') return 'public';
            }
            // Check for accessibility modifiers on methods
            const accessMod = node.childForFieldName('accessibility');
            if (accessMod) {
                const modText = accessMod.text;
                if (modText === 'private') return 'private';
                if (modText === 'protected') return 'protected';
                if (modText === 'public') return 'public';
            }
            // Check if any child is an accessibility_modifier
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'accessibility_modifier') {
                    const modText = child.text;
                    if (modText === 'private') return 'private';
                    if (modText === 'protected') return 'protected';
                    if (modText === 'public') return 'public';
                }
            }
            // Check for 'export' in the node text (variable statements with export)
            if (parent && parent.type === 'export_statement') return 'public';
            // Look for 'export' keyword in lexical_declaration parent
            const grandparent = parent?.parent;
            if (grandparent && grandparent.type === 'export_statement') return 'public';
            return 'internal';
        }
        case 'python': {
            // Python: names starting with _ are private, __ are more private
            const nameNode = node.childForFieldName('name');
            const name = nameNode?.text || '';
            if (name.startsWith('__') && !name.endsWith('__')) return 'private';
            if (name.startsWith('_')) return 'protected';
            return 'public';
        }
        case 'cpp': {
            // Check for access specifiers in the parent class scope
            // In tree-sitter-cpp, class members have access_specifier siblings
            if (parentNode) {
                // Walk backwards from this node to find the nearest access_specifier
                let sibling = node.previousNamedSibling;
                while (sibling) {
                    if (sibling.type === 'access_specifier') {
                        const specText = sibling.text.replace(':', '').trim();
                        if (specText === 'private') return 'private';
                        if (specText === 'protected') return 'protected';
                        if (specText === 'public') return 'public';
                    }
                    sibling = sibling.previousNamedSibling;
                }
                // If inside struct, default is public; if inside class, default is private
                if (parentNode.type === 'struct_specifier') return 'public';
                return 'private';
            }
            // Top-level: check for static keyword
            if (text.includes('static ')) return 'internal';
            return 'public';
        }
        case 'go': {
            // Go: exported if name starts with uppercase
            const nameNode = node.childForFieldName('name');
            const name = nameNode?.text || '';
            const firstChar = name[0];
            if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
                return 'public';
            }
            return 'internal';
        }
        case 'rust': {
            // Rust visibility modifiers
            const nodeText = node.text as string;
            // Check for visibility_modifier child
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'visibility_modifier') {
                    const modText = child.text;
                    if (modText === 'pub') return 'public';
                    if (modText.includes('pub(crate)')) return 'internal';
                    if (modText.includes('pub(super)')) return 'protected';
                    return 'public';
                }
            }
            // Check parent for visibility (e.g., in impl blocks)
            if (node.parent) {
                for (let i = 0; i < node.parent.childCount; i++) {
                    const sibling = node.parent.child(i);
                    if (sibling === node) break;
                    if (sibling && sibling.type === 'visibility_modifier') {
                        const modText = sibling.text;
                        if (modText === 'pub') return 'public';
                        if (modText.includes('pub(crate)')) return 'internal';
                        if (modText.includes('pub(super)')) return 'protected';
                    }
                }
            }
            // Check if the raw text starts with pub
            if (nodeText.startsWith('pub(crate)')) return 'internal';
            if (nodeText.startsWith('pub(super)')) return 'protected';
            if (nodeText.startsWith('pub ') || nodeText.startsWith('pub(')) return 'public';
            return 'private';
        }
        case 'java': {
            // Java visibility from modifiers
            const nodeText = node.text as string;
            // Check for modifiers child node
            const modifiers = node.childForFieldName('modifiers') || findDescendantByType(node, 'modifiers');
            if (modifiers) {
                const modText = modifiers.text;
                if (modText.includes('private')) return 'private';
                if (modText.includes('protected')) return 'protected';
                if (modText.includes('public')) return 'public';
                return 'internal'; // package-private
            }
            // Fallback: check raw text
            const firstLine = nodeText.split('\n')[0] || '';
            if (firstLine.includes('private ')) return 'private';
            if (firstLine.includes('protected ')) return 'protected';
            if (firstLine.includes('public ')) return 'public';
            return 'internal'; // package-private
        }
        case 'csharp': {
            // C# visibility
            const nodeText = node.text as string;
            const firstLine = nodeText.split('\n')[0] || '';
            if (firstLine.includes('private ')) return 'private';
            if (firstLine.includes('protected ')) return 'protected';
            if (firstLine.includes('internal ')) return 'internal';
            if (firstLine.includes('public ')) return 'public';
            // Default for C# is private for class members, internal for types
            if (parentNode) return 'private';
            return 'internal';
        }
        case 'ruby': {
            // Ruby: default is public. Look for private/protected blocks above.
            let sibling = node.previousNamedSibling;
            while (sibling) {
                if (sibling.type === 'call' || sibling.type === 'identifier') {
                    const sibText = sibling.text.trim();
                    if (sibText === 'private') return 'private';
                    if (sibText === 'protected') return 'protected';
                    if (sibText === 'public') return 'public';
                }
                sibling = sibling.previousNamedSibling;
            }
            return 'public';
        }
        case 'kotlin': {
            const nodeText = node.text as string;
            const firstLine = nodeText.split('\n')[0] || '';
            if (firstLine.includes('private ')) return 'private';
            if (firstLine.includes('protected ')) return 'protected';
            if (firstLine.includes('internal ')) return 'internal';
            return 'public'; // Kotlin default is public
        }
        case 'swift': {
            const nodeText = node.text as string;
            const firstLine = nodeText.split('\n')[0] || '';
            if (firstLine.includes('private ') || firstLine.includes('fileprivate ')) return 'private';
            if (firstLine.includes('internal ')) return 'internal';
            if (firstLine.includes('public ') || firstLine.includes('open ')) return 'public';
            return 'internal'; // Swift default is internal
        }
        case 'php': {
            const nodeText = node.text as string;
            const firstLine = nodeText.split('\n')[0] || '';
            if (firstLine.includes('private ')) return 'private';
            if (firstLine.includes('protected ')) return 'protected';
            if (firstLine.includes('public ')) return 'public';
            return parentNode ? 'public' : 'public'; // PHP default for functions is public
        }
        case 'bash': {
            return 'public'; // Bash functions are always accessible
        }
        default:
            return 'public';
    }
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function extractSignature(node: SyntaxNode, language: SupportedLanguage): string {
    switch (language) {
        case 'typescript':
        case 'javascript':
            return extractTSSignature(node);
        case 'python':
            return extractPythonSignature(node);
        case 'cpp':
            return extractCppSignature(node);
        case 'go':
            return extractGoSignature(node);
        case 'rust':
            return extractRustSignature(node);
        case 'java':
            return extractJavaSignature(node);
        case 'csharp':
            return extractCSharpSignature(node);
        case 'ruby':
            return extractRubySignature(node);
        case 'kotlin':
            return extractKotlinSignature(node);
        case 'swift':
            return extractSwiftSignature(node);
        case 'php':
            return extractPhpSignature(node);
        case 'bash':
            return extractBashSignature(node);
        default:
            return node.text.substring(0, 120);
    }
}

function extractKotlinSignature(node: SyntaxNode): string {
    // Kotlin: class names use type_identifier, function names use simple_identifier
    const type = node.type;
    let nameNode = node.childForFieldName('name');
    if (!nameNode) {
        // For classes, look for type_identifier first (the class name)
        if (type === 'class_declaration' || type === 'interface_declaration' || type === 'object_declaration') {
            for (let i = 0; i < Math.min(node.namedChildCount, 3); i++) {
                const child = node.namedChild(i);
                if (child && child.type === 'type_identifier') { nameNode = child; break; }
            }
        }
        // For functions, look for simple_identifier
        if (!nameNode) {
            for (let i = 0; i < Math.min(node.namedChildCount, 3); i++) {
                const child = node.namedChild(i);
                if (child && child.type === 'simple_identifier') { nameNode = child; break; }
            }
        }
    }
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_declaration') {
        const params = node.childForFieldName('function_value_parameters') || node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type') || node.childForFieldName('type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ': ' + returnType.text : '';
        return `fun ${name}${paramsText}${retText}`;
    }
    if (type === 'class_declaration') return `class ${name}`;
    if (type === 'object_declaration') return `object ${name}`;
    if (type === 'interface_declaration') return `interface ${name}`;
    if (type === 'property_declaration') {
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    return (node.text.split('\n')[0] || '').substring(0, 200);
}

function extractSwiftSignature(node: SyntaxNode): string {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';
    const type = node.type;
    if (type === 'function_declaration') {
        const body = node.childForFieldName('body');
        if (body) {
            const sigText = node.text.substring(0, body.startIndex - node.startIndex).trim();
            return sigText.substring(0, 300);
        }
        return (node.text.split('\n')[0] || '').substring(0, 200);
    }
    if (type === 'class_declaration') return `class ${name}`;
    if (type === 'struct_declaration') return `struct ${name}`;
    if (type === 'protocol_declaration') return `protocol ${name}`;
    if (type === 'enum_declaration') return `enum ${name}`;
    if (type === 'extension_declaration') return `extension ${name}`;
    if (type === 'typealias_declaration') return `typealias ${name}`;
    return (node.text.split('\n')[0] || '').substring(0, 200);
}

function extractPhpSignature(node: SyntaxNode): string {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';
    const type = node.type;
    if (type === 'function_definition' || type === 'method_declaration') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ': ' + returnType.text : '';
        return `function ${name}${paramsText}${retText}`;
    }
    if (type === 'class_declaration') return `class ${name}`;
    if (type === 'interface_declaration') return `interface ${name}`;
    if (type === 'trait_declaration') return `trait ${name}`;
    if (type === 'enum_declaration') return `enum ${name}`;
    if (type === 'namespace_definition') return `namespace ${name}`;
    return (node.text.split('\n')[0] || '').substring(0, 200);
}

function extractBashSignature(node: SyntaxNode): string {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';
    return `${name}()`;
}

function extractTSSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_declaration' || type === 'method_definition' ||
        type === 'function_signature' || type === 'method_signature') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ': ' + returnType.text : '';
        return `${name}${paramsText}${retText}`;
    }
    if (type === 'class_declaration') {
        return `class ${name}`;
    }
    if (type === 'interface_declaration') {
        return `interface ${name}`;
    }
    if (type === 'type_alias_declaration') {
        return `type ${name}`;
    }
    if (type === 'enum_declaration') {
        return `enum ${name}`;
    }
    if (type === 'variable_declarator') {
        const valueNode = node.childForFieldName('value');
        if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
            const params = valueNode.childForFieldName('parameters');
            const returnType = valueNode.childForFieldName('return_type');
            const paramsText = params ? params.text : '()';
            const retText = returnType ? ': ' + returnType.text : '';
            return `${name}${paramsText}${retText}`;
        }
        const typeAnnotation = node.childForFieldName('type');
        if (typeAnnotation) {
            return `${name}: ${typeAnnotation.text}`;
        }
        return name;
    }
    if (type === 'lexical_declaration') {
        // Take first declarator
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type === 'variable_declarator') {
                return extractTSSignature(child);
            }
        }
        return node.text.substring(0, 120);
    }
    // Fallback: first line
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractPythonSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_definition') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ' -> ' + returnType.text : '';
        return `def ${name}${paramsText}${retText}`;
    }
    if (type === 'class_definition') {
        const superclasses = node.childForFieldName('superclasses');
        const superText = superclasses ? superclasses.text : '';
        return `class ${name}${superText}`;
    }
    if (type === 'decorated_definition') {
        // Get the inner definition
        const definition = node.childForFieldName('definition');
        if (definition) return extractPythonSignature(definition);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractCppSignature(node: SyntaxNode): string {
    const type = node.type;

    if (type === 'function_definition') {
        // Get everything before the body
        const body = node.childForFieldName('body');
        if (body) {
            const sigEnd = body.startIndex;
            const sigText = node.text.substring(0, sigEnd - node.startIndex).trim();
            return sigText.substring(0, 300);
        }
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'class_specifier' || type === 'struct_specifier') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        const prefix = type === 'struct_specifier' ? 'struct' : 'class';
        // Check for base classes
        const baseClause = node.children.find((c: SyntaxNode) => c.type === 'base_class_clause');
        const baseText = baseClause ? ' ' + baseClause.text : '';
        return `${prefix} ${name}${baseText}`;
    }
    if (type === 'enum_specifier') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        return `enum ${name}`;
    }
    if (type === 'namespace_definition') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        return `namespace ${name}`;
    }
    if (type === 'template_declaration') {
        // Get the parameters and the inner declaration's signature
        const params = node.childForFieldName('parameters');
        const paramsText = params ? params.text : '';
        // Find the inner declaration
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type !== 'template_parameter_list') {
                const innerSig = extractCppSignature(child);
                return `template${paramsText} ${innerSig}`;
            }
        }
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractGoSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_declaration') {
        const params = node.childForFieldName('parameters');
        const result = node.childForFieldName('result');
        const paramsText = params ? params.text : '()';
        const retText = result ? ' ' + result.text : '';
        return `func ${name}${paramsText}${retText}`;
    }
    if (type === 'method_declaration') {
        const receiver = node.childForFieldName('receiver');
        const params = node.childForFieldName('parameters');
        const result = node.childForFieldName('result');
        const recvText = receiver ? receiver.text + ' ' : '';
        const paramsText = params ? params.text : '()';
        const retText = result ? ' ' + result.text : '';
        return `func ${recvText}${name}${paramsText}${retText}`;
    }
    if (type === 'type_declaration') {
        // This wraps type_spec nodes
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'type_spec') {
        const typeName = node.childForFieldName('name')?.text || 'anonymous';
        const typeVal = node.childForFieldName('type');
        if (typeVal) {
            if (typeVal.type === 'struct_type') return `type ${typeName} struct`;
            if (typeVal.type === 'interface_type') return `type ${typeName} interface`;
            return `type ${typeName} ${typeVal.text.substring(0, 60)}`;
        }
        return `type ${typeName}`;
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractRustSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_item') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const typeParams = node.childForFieldName('type_parameters');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ' -> ' + returnType.text : '';
        const genericText = typeParams ? typeParams.text : '';
        return `fn ${name}${genericText}${paramsText}${retText}`;
    }
    if (type === 'struct_item') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `struct ${name}${genericText}`;
    }
    if (type === 'enum_item') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `enum ${name}${genericText}`;
    }
    if (type === 'trait_item') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `trait ${name}${genericText}`;
    }
    if (type === 'impl_item') {
        // impl Trait for Type or impl Type
        const traitNode = node.childForFieldName('trait');
        const typeNode = node.childForFieldName('type');
        if (traitNode && typeNode) {
            return `impl ${traitNode.text} for ${typeNode.text}`;
        }
        if (typeNode) {
            return `impl ${typeNode.text}`;
        }
        return `impl ${name}`;
    }
    if (type === 'mod_item') {
        return `mod ${name}`;
    }
    if (type === 'const_item' || type === 'static_item') {
        const typeNode = node.childForFieldName('type');
        const prefix = type === 'const_item' ? 'const' : 'static';
        const typeText = typeNode ? ': ' + typeNode.text : '';
        return `${prefix} ${name}${typeText}`;
    }
    if (type === 'type_item') {
        return `type ${name}`;
    }
    if (type === 'macro_definition') {
        return `macro ${name}!`;
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractJavaSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'method_declaration') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('type');
        const typeParams = node.childForFieldName('type_parameters');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? returnType.text + ' ' : 'void ';
        const genericText = typeParams ? typeParams.text + ' ' : '';
        // Include throws clause
        const body = node.childForFieldName('body');
        if (body) {
            const sigEnd = body.startIndex;
            const sigText = node.text.substring(0, sigEnd - node.startIndex).trim();
            return sigText.substring(0, 300);
        }
        return `${genericText}${retText}${name}${paramsText}`;
    }
    if (type === 'constructor_declaration') {
        const params = node.childForFieldName('parameters');
        const paramsText = params ? params.text : '()';
        return `${name}${paramsText}`;
    }
    if (type === 'class_declaration') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `class ${name}${genericText}`;
    }
    if (type === 'interface_declaration') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `interface ${name}${genericText}`;
    }
    if (type === 'enum_declaration') {
        return `enum ${name}`;
    }
    if (type === 'annotation_type_declaration') {
        return `@interface ${name}`;
    }
    if (type === 'field_declaration') {
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.replace(/;.*$/, '').trim().substring(0, 200);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractCSharpSignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'method_declaration') {
        const body = node.childForFieldName('body');
        if (body) {
            const sigEnd = body.startIndex;
            const sigText = node.text.substring(0, sigEnd - node.startIndex).trim();
            return sigText.substring(0, 300);
        }
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'class_declaration') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `class ${name}${genericText}`;
    }
    if (type === 'interface_declaration') {
        const typeParams = node.childForFieldName('type_parameters');
        const genericText = typeParams ? typeParams.text : '';
        return `interface ${name}${genericText}`;
    }
    if (type === 'struct_declaration') {
        return `struct ${name}`;
    }
    if (type === 'enum_declaration') {
        return `enum ${name}`;
    }
    if (type === 'namespace_declaration') {
        return `namespace ${name}`;
    }
    if (type === 'property_declaration') {
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'delegate_declaration') {
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.replace(/;.*$/, '').trim().substring(0, 200);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractRubySignature(node: SyntaxNode): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'method' || type === 'singleton_method') {
        const params = node.childForFieldName('parameters');
        const paramsText = params ? params.text : '';
        const prefix = type === 'singleton_method' ? 'def self.' : 'def ';
        return `${prefix}${name}${paramsText ? '(' + paramsText + ')' : ''}`;
    }
    if (type === 'class') {
        const superclass = node.childForFieldName('superclass');
        const superText = superclass ? ' < ' + superclass.text : '';
        return `class ${name}${superText}`;
    }
    if (type === 'module') {
        return `module ${name}`;
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

function classifyKind(node: SyntaxNode, language: SupportedLanguage): string {
    const type = node.type;
    switch (language) {
        case 'typescript':
        case 'javascript': {
            if (type === 'class_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'type_alias_declaration') return 'type_alias';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'method_definition' || type === 'method_signature') return 'method';
            if (type === 'function_declaration' || type === 'function_signature') return 'function';
            if (type === 'variable_declarator' || type === 'lexical_declaration') {
                // Check if the value is a function/arrow
                const valueNode = type === 'variable_declarator'
                    ? node.childForFieldName('value')
                    : node.namedChild(0)?.childForFieldName?.('value');
                if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
                    return 'function';
                }
                return 'variable';
            }
            if (type === 'arrow_function' || type === 'function_expression' || type === 'function') return 'function';
            return 'function';
        }
        case 'python': {
            if (type === 'function_definition') return 'function';
            if (type === 'class_definition') return 'class';
            if (type === 'decorated_definition') {
                const definition = node.childForFieldName('definition');
                if (definition) return classifyKind(definition, language);
                return 'function';
            }
            return 'function';
        }
        case 'cpp': {
            if (type === 'function_definition') return 'function';
            if (type === 'class_specifier') return 'class';
            if (type === 'struct_specifier') return 'class';
            if (type === 'enum_specifier') return 'enum';
            if (type === 'namespace_definition') return 'module';
            if (type === 'template_declaration') {
                // Classify based on inner declaration
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type !== 'template_parameter_list') {
                        return classifyKind(child, language);
                    }
                }
                return 'function';
            }
            return 'function';
        }
        case 'go': {
            if (type === 'function_declaration') return 'function';
            if (type === 'method_declaration') return 'method';
            if (type === 'type_spec') {
                const typeVal = node.childForFieldName('type');
                if (typeVal) {
                    if (typeVal.type === 'struct_type') return 'class';
                    if (typeVal.type === 'interface_type') return 'interface';
                }
                return 'type_alias';
            }
            if (type === 'type_declaration') {
                // Check inner type_spec nodes
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type === 'type_spec') {
                        return classifyKind(child, language);
                    }
                }
                return 'type_alias';
            }
            if (type === 'const_declaration' || type === 'var_declaration') return 'variable';
            return 'variable';
        }
        case 'rust': {
            if (type === 'function_item') return 'function';
            if (type === 'struct_item') return 'class';
            if (type === 'enum_item') return 'enum';
            if (type === 'trait_item') return 'interface';
            if (type === 'impl_item') return 'class';
            if (type === 'mod_item') return 'module';
            if (type === 'const_item' || type === 'static_item') return 'variable';
            if (type === 'type_item') return 'type_alias';
            if (type === 'macro_definition') return 'function';
            return 'function';
        }
        case 'java': {
            if (type === 'method_declaration') return 'method';
            if (type === 'constructor_declaration') return 'method';
            if (type === 'class_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'field_declaration') return 'variable';
            if (type === 'annotation_type_declaration') return 'type_alias';
            return 'function';
        }
        case 'csharp': {
            if (type === 'method_declaration') return 'method';
            if (type === 'class_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'struct_declaration') return 'class';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'property_declaration') return 'variable';
            if (type === 'delegate_declaration') return 'type_alias';
            if (type === 'namespace_declaration') return 'module';
            return 'function';
        }
        case 'ruby': {
            if (type === 'method') return 'function';
            if (type === 'singleton_method') return 'function';
            if (type === 'class') return 'class';
            if (type === 'module') return 'module';
            return 'function';
        }
        case 'kotlin': {
            if (type === 'function_declaration') return 'function';
            if (type === 'class_declaration') return 'class';
            if (type === 'object_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'property_declaration') return 'variable';
            if (type === 'companion_object') return 'class';
            return 'function';
        }
        case 'swift': {
            if (type === 'function_declaration') return 'function';
            if (type === 'class_declaration') return 'class';
            if (type === 'struct_declaration') return 'class';
            if (type === 'protocol_declaration') return 'interface';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'extension_declaration') return 'class';
            if (type === 'typealias_declaration') return 'type_alias';
            return 'function';
        }
        case 'php': {
            if (type === 'function_definition') return 'function';
            if (type === 'method_declaration') return 'method';
            if (type === 'class_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'trait_declaration') return 'class';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'namespace_definition') return 'module';
            return 'function';
        }
        case 'bash': {
            if (type === 'function_definition') return 'function';
            return 'function';
        }
        default:
            return 'function';
    }
}

// ---------------------------------------------------------------------------
// Behavior hint extraction — AST-aware, skips comments and strings
// ---------------------------------------------------------------------------

/** Node types that should be excluded from behavior pattern matching.
 *  Matching inside these nodes produces false positives (e.g., a comment
 *  mentioning ".save()" is not an actual DB write). */
const SKIP_NODE_TYPES = new Set([
    'comment', 'line_comment', 'block_comment',
    'string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal',
    'string_content', 'string_fragment',
    'template_string', 'template_literal_type',
    'heredoc_body', 'heredoc_content',
    'regex', 'regex_pattern',
    // Python
    'concatenated_string',
]);

/**
 * Extract code-only text from a tree-sitter subtree, excluding comments
 * and string literal contents. Uses byte ranges to reconstruct the original
 * source text with comment/string content replaced by whitespace, preserving
 * the original character positions and formatting so regex patterns match
 * exactly as they would on source code.
 */
function extractCodeOnlyText(node: SyntaxNode): string {
    // Collect byte ranges of all comment and string nodes to blank out
    const blankRanges: { start: number; end: number }[] = [];

    function collectSkipRanges(n: SyntaxNode): void {
        if (SKIP_NODE_TYPES.has(n.type)) {
            blankRanges.push({ start: n.startIndex, end: n.endIndex });
            return; // Don't recurse into skipped nodes
        }
        for (let i = 0; i < n.childCount; i++) {
            const child = n.child(i);
            if (child) collectSkipRanges(child);
        }
    }

    collectSkipRanges(node);

    // Replace skipped ranges with spaces in the original text
    const chars = node.text.split('');
    const baseOffset = node.startIndex;
    for (const range of blankRanges) {
        const start = range.start - baseOffset;
        const end = range.end - baseOffset;
        for (let i = Math.max(0, start); i < Math.min(chars.length, end); i++) {
            // Preserve newlines so line-number tracking stays correct
            if (chars[i] !== '\n') chars[i] = ' ';
        }
    }

    return chars.join('');
}

/**
 * Extract behavior hints from a symbol's body using AST-aware text extraction.
 * Only matches patterns against actual code — comments and strings are excluded.
 *
 * Two-strategy approach:
 *   1. Extract code-only text from AST (filters comments/strings at tree level)
 *   2. Run behavior patterns against the clean code text
 *
 * This eliminates false positives like:
 *   - `// TODO: add .save() call` → no longer triggers db_write
 *   - `"Call .delete() to remove"` → no longer triggers db_delete
 */
function extractBehaviorHints(
    bodyText: string,
    symbolKey: string,
    baseLine: number,
    hints: BehaviorHint[],
    bodyNode?: SyntaxNode,
    language?: SupportedLanguage,
): void {
    // If we have the AST node, use AST-aware extraction (preferred)
    const textToScan = bodyNode ? extractCodeOnlyText(bodyNode) : bodyText;

    // Pre-filter patterns by language for efficiency
    const applicablePatterns = language
        ? BEHAVIOR_PATTERNS.filter(bp => !bp.languages || bp.languages.includes(language))
        : BEHAVIOR_PATTERNS;

    // Split into lines for line-number tracking
    const lines = textToScan.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const bp of applicablePatterns) {
            if (bp.pattern.test(line)) {
                hints.push({
                    symbol_key: symbolKey,
                    hint_type: bp.hint_type,
                    detail: bp.detail,
                    line: baseLine + i,
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Contract hint extraction
// ---------------------------------------------------------------------------

function extractContractHint(
    node: SyntaxNode,
    symbolKey: string,
    language: SupportedLanguage,
    hints: ContractHint[],
): void {
    const text = node.text as string;
    const inputTypes: string[] = [];
    let outputType = 'void';
    const thrownTypes: string[] = [];
    const decorators: string[] = [];

    switch (language) {
        case 'typescript':
        case 'javascript': {
            // Parameters
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && (param.type === 'required_parameter' ||
                                  param.type === 'optional_parameter' ||
                                  param.type === 'formal_parameters')) {
                        const typeAnnotation = param.childForFieldName('type');
                        inputTypes.push(typeAnnotation ? typeAnnotation.text : 'any');
                    } else if (param && param.type === 'identifier') {
                        inputTypes.push('any');
                    }
                }
            }
            // For variable_declarator pointing to arrow/function
            if (node.type === 'variable_declarator') {
                const valueNode = node.childForFieldName('value');
                if (valueNode) {
                    const innerParams = valueNode.childForFieldName('parameters');
                    if (innerParams) {
                        for (let i = 0; i < innerParams.namedChildCount; i++) {
                            const param = innerParams.namedChild(i);
                            if (param) {
                                const typeAnnotation = param.childForFieldName('type');
                                inputTypes.push(typeAnnotation ? typeAnnotation.text : 'any');
                            }
                        }
                    }
                    const innerReturnType = valueNode.childForFieldName('return_type');
                    if (innerReturnType) outputType = innerReturnType.text;
                }
            }
            // Return type
            const returnType = node.childForFieldName('return_type');
            if (returnType) outputType = returnType.text;
            // Decorators
            const parent = node.parent;
            if (parent && parent.type === 'export_statement') {
                // Check for decorators on the export statement
                for (let i = 0; i < parent.namedChildCount; i++) {
                    const child = parent.namedChild(i);
                    if (child && child.type === 'decorator') {
                        decorators.push(child.text);
                    }
                }
            }
            // Decorators directly on node
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'decorator') {
                    decorators.push(child.text);
                }
            }
            break;
        }
        case 'python': {
            let targetNode = node;
            // If decorated_definition, extract decorators and dig into the definition
            if (node.type === 'decorated_definition') {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type === 'decorator') {
                        decorators.push(child.text);
                    }
                }
                const def = node.childForFieldName('definition');
                if (def) targetNode = def;
            }
            const params = targetNode.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (!param) continue;
                    if (param.type === 'identifier') {
                        // Skip 'self' and 'cls'
                        if (param.text !== 'self' && param.text !== 'cls') {
                            inputTypes.push('Any');
                        }
                    } else if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'Any');
                    } else if (param.type === 'default_parameter') {
                        inputTypes.push('Any');
                    }
                }
            }
            const returnType = targetNode.childForFieldName('return_type');
            if (returnType) outputType = returnType.text;
            break;
        }
        case 'cpp': {
            if (node.type === 'function_definition' || node.type === 'template_declaration') {
                let funcNode = node;
                if (node.type === 'template_declaration') {
                    // Find the inner function definition
                    for (let i = 0; i < node.namedChildCount; i++) {
                        const child = node.namedChild(i);
                        if (child && child.type === 'function_definition') {
                            funcNode = child;
                            break;
                        }
                    }
                }
                const declarator = funcNode.childForFieldName('declarator');
                if (declarator) {
                    // Find parameter_list inside the declarator
                    const paramList = findDescendantByType(declarator, 'parameter_list');
                    if (paramList) {
                        for (let i = 0; i < paramList.namedChildCount; i++) {
                            const param = paramList.namedChild(i);
                            if (param && param.type === 'parameter_declaration') {
                                const typeNode = param.childForFieldName('type');
                                inputTypes.push(typeNode ? typeNode.text : 'auto');
                            }
                        }
                    }
                }
                const typeNode = funcNode.childForFieldName('type');
                if (typeNode) outputType = typeNode.text;
            }
            break;
        }
        case 'go': {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && param.type === 'parameter_declaration') {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'interface{}');
                    }
                }
            }
            const result = node.childForFieldName('result');
            if (result) outputType = result.text;
            break;
        }
        case 'rust': {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (!param) continue;
                    if (param.type === 'parameter' || param.type === 'self_parameter') {
                        const typeNode = param.childForFieldName('type');
                        if (typeNode) {
                            inputTypes.push(typeNode.text);
                        } else if (param.type === 'self_parameter') {
                            inputTypes.push('self');
                        } else {
                            inputTypes.push('_');
                        }
                    }
                }
            }
            const returnType = node.childForFieldName('return_type');
            if (returnType) {
                const retText = returnType.text;
                outputType = retText;
                // Extract error type from Result<T, E>
                const resultMatch = retText.match(/Result\s*<\s*([^,]+)\s*,\s*([^>]+)\s*>/);
                if (resultMatch && resultMatch[1] && resultMatch[2]) {
                    outputType = resultMatch[1].trim();
                    thrownTypes.push(resultMatch[2].trim());
                }
            }
            // Generic bounds as type constraints (for contract info)
            const typeParams = node.childForFieldName('type_parameters');
            if (typeParams) {
                decorators.push(`generics: ${typeParams.text}`);
            }
            break;
        }
        case 'java': {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && (param.type === 'formal_parameter' || param.type === 'spread_parameter')) {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'Object');
                    }
                }
            }
            const returnType = node.childForFieldName('type');
            if (returnType) outputType = returnType.text;
            // Throws clause
            const throwsClauseText = text.match(/throws\s+([\w\s,.<>]+?)(?:\s*\{|\s*;)/);
            if (throwsClauseText && throwsClauseText[1]) {
                const types = throwsClauseText[1].split(',').map((t: string) => t.trim()).filter(Boolean);
                thrownTypes.push(...types);
            }
            // Annotations as decorators
            const modifiers = node.childForFieldName('modifiers');
            if (modifiers) {
                for (let i = 0; i < modifiers.namedChildCount; i++) {
                    const child = modifiers.namedChild(i);
                    if (child && (child.type === 'annotation' || child.type === 'marker_annotation')) {
                        decorators.push(child.text);
                    }
                }
            }
            // Type parameters (generics)
            const typeParams = node.childForFieldName('type_parameters');
            if (typeParams) {
                decorators.push(`generics: ${typeParams.text}`);
            }
            break;
        }
        case 'csharp': {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && param.type === 'parameter') {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'object');
                    }
                }
            }
            const returnType = node.childForFieldName('type');
            if (returnType) outputType = returnType.text;
            // Attributes (decorators)
            const attrLists = node.descendantsOfType?.('attribute_list') || [];
            for (const attrList of attrLists) {
                // Only count direct attributes, not nested
                if (attrList.parent === node || attrList.parent?.parent === node) {
                    for (let i = 0; i < attrList.namedChildCount; i++) {
                        const attr = attrList.namedChild(i);
                        if (attr) decorators.push(attr.text);
                    }
                }
            }
            break;
        }
        case 'ruby': {
            // Ruby doesn't have static types, but we can extract parameter names
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param) {
                        inputTypes.push(param.text);
                    }
                }
            }
            outputType = 'dynamic';
            break;
        }
    }

    // Extract thrown types from body text (works across all languages)
    const throwMatches = text.matchAll(/throw\s+new\s+(\w+)/g);
    for (const match of throwMatches) {
        if (match[1]) thrownTypes.push(match[1]);
    }
    // Python raise
    const raiseMatches = text.matchAll(/raise\s+(\w+)\s*\(/g);
    for (const match of raiseMatches) {
        if (match[1]) thrownTypes.push(match[1]);
    }
    // Ruby raise
    const rubyRaiseMatches = text.matchAll(/raise\s+(\w+(?:::\w+)*)/g);
    for (const match of rubyRaiseMatches) {
        if (match[1]) thrownTypes.push(match[1]);
    }
    // Rust ? operator indicates error propagation
    if (language === 'rust' && text.includes('?')) {
        // The error type should already be extracted from Result<T, E> return type
        if (thrownTypes.length === 0) {
            thrownTypes.push('Error');
        }
    }

    hints.push({
        symbol_key: symbolKey,
        input_types: inputTypes,
        output_type: outputType,
        thrown_types: [...new Set(thrownTypes)],
        decorators,
    });
}

function findDescendantByType(node: SyntaxNode, type: string): SyntaxNode | null {
    if (node.type === type) return node;
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            const found = findDescendantByType(child, type);
            if (found) return found;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Relation extraction
// ---------------------------------------------------------------------------

function extractRelationsFromNode(
    node: SyntaxNode,
    sourceKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    // Walk the entire subtree of this node looking for call expressions,
    // type references, etc.
    walkForRelations(node, sourceKey, language, relations);
}

function walkForRelations(
    node: SyntaxNode,
    sourceKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    if (!node) return;
    const type = node.type;

    // Call expressions — use full call chain extraction for ALL languages
    if (type === 'call_expression' || type === 'call') {
        const funcNode = node.childForFieldName('function');
        if (funcNode) {
            // Use extractFullCallChain for composite expressions
            const chainTypes = new Set([
                'member_expression', 'property_access_expression',
                'selector_expression', 'attribute', 'field_expression',
                'scoped_identifier', 'qualified_identifier',
                'member_access_expression', 'scope_resolution',
            ]);
            let targetName: string | null = null;
            if (funcNode.type === 'identifier' || funcNode.type === 'field_identifier') {
                targetName = funcNode.text;
            } else if (chainTypes.has(funcNode.type)) {
                // Extract FULL call chain instead of just the final method
                targetName = extractFullCallChain(funcNode, language);
            } else {
                // Fallback: try extractFullCallChain anyway
                const chain = extractFullCallChain(funcNode, language);
                if (chain && chain.length < 200) {
                    targetName = chain;
                }
            }
            if (targetName) {
                relations.push({
                    source_key: sourceKey,
                    target_name: targetName,
                    relation_type: 'calls' as StructuralRelationType,
                });
            }
        }
        // Python/Go/Ruby: the function might be direct identifier child (no 'function' field)
        if (!node.childForFieldName('function')) {
            const firstChild = node.namedChild(0);
            if (firstChild) {
                let targetName: string | null = null;
                if (firstChild.type === 'identifier') {
                    targetName = firstChild.text;
                } else {
                    targetName = extractFullCallChain(firstChild, language);
                }
                if (targetName) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: targetName,
                        relation_type: 'calls' as StructuralRelationType,
                    });
                }
            }
        }
    }

    // Rust-specific: method_call_expression (receiver.method(args))
    if (type === 'method_call_expression' && language === 'rust') {
        // field_expression or identifier as receiver, then method name
        const fullChain = extractFullCallChain(node, language);
        if (fullChain) {
            relations.push({
                source_key: sourceKey,
                target_name: fullChain,
                relation_type: 'calls' as StructuralRelationType,
            });
        }
    }

    // Rust-specific: macro_invocation (println!, vec![], derive, etc.)
    if (type === 'macro_invocation' && language === 'rust') {
        const fullChain = extractFullCallChain(node, language);
        if (fullChain) {
            relations.push({
                source_key: sourceKey,
                target_name: fullChain,
                relation_type: 'calls' as StructuralRelationType,
            });
        }
    }

    // Ruby-specific: method_call
    if (type === 'method_call' && language === 'ruby') {
        const fullChain = extractFullCallChain(node, language);
        if (fullChain) {
            relations.push({
                source_key: sourceKey,
                target_name: fullChain,
                relation_type: 'calls' as StructuralRelationType,
            });
        }
    }

    // C#-specific: invocation_expression
    if (type === 'invocation_expression' && language === 'csharp') {
        const funcNode = node.childForFieldName('function') || node.namedChild(0);
        if (funcNode) {
            const fullChain = extractFullCallChain(funcNode, language);
            if (fullChain) {
                relations.push({
                    source_key: sourceKey,
                    target_name: fullChain,
                    relation_type: 'calls' as StructuralRelationType,
                });
            }
        }
    }

    // Java-specific: method_invocation
    if (type === 'method_invocation' && language === 'java') {
        const obj = node.childForFieldName('object');
        const methodName = node.childForFieldName('name');
        if (obj && methodName) {
            const objChain = extractFullCallChain(obj, language);
            const target = objChain ? `${objChain}.${methodName.text}` : methodName.text;
            relations.push({
                source_key: sourceKey,
                target_name: target,
                relation_type: 'calls' as StructuralRelationType,
            });
        } else if (methodName) {
            relations.push({
                source_key: sourceKey,
                target_name: methodName.text,
                relation_type: 'calls' as StructuralRelationType,
            });
        }
    }

    // Type references (TypeScript, and extended for other languages)
    if (type === 'type_identifier' || type === 'generic_type') {
        const typeName = type === 'generic_type'
            ? node.namedChild(0)?.text || node.text
            : node.text;
        const builtinTypes = new Set([
            'void', 'string', 'number', 'boolean', 'any', 'unknown',
            'never', 'null', 'undefined', 'int', 'float', 'double',
            'char', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128',
            'u8', 'u16', 'u32', 'u64', 'u128', 'f32', 'f64',
            'usize', 'isize', 'str', 'String', 'byte', 'long',
            'short', 'object', 'dynamic',
        ]);
        if (typeName && !builtinTypes.has(typeName)) {
            relations.push({
                source_key: sourceKey,
                target_name: typeName,
                relation_type: 'typed_as' as StructuralRelationType,
            });
        }
    }

    // Rust use declarations
    if (type === 'use_declaration' && language === 'rust') {
        const argument = node.childForFieldName('argument');
        if (argument) {
            relations.push({
                source_key: sourceKey,
                target_name: argument.text,
                relation_type: 'imports' as StructuralRelationType,
            });
        }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            walkForRelations(child, sourceKey, language, relations);
        }
    }
}

// ---------------------------------------------------------------------------
// Import relation extraction
// ---------------------------------------------------------------------------

function extractImportRelations(
    rootNode: SyntaxNode,
    filePath: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    const sourceKey = `${filePath}::__module__`;

    switch (language) {
        case 'typescript':
        case 'javascript': {
            const imports = rootNode.descendantsOfType('import_statement');
            for (const imp of imports) {
                const sourceNode = imp.childForFieldName('source');
                const moduleName = sourceNode?.text?.replace(/['"]/g, '') || '';
                if (!moduleName) continue;

                // Extract named imports
                const clauseNodes = imp.descendantsOfType('import_specifier');
                for (const spec of clauseNodes) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text || spec.text;
                    relations.push({
                        source_key: sourceKey,
                        target_name: `${moduleName}::${name}`,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }

                // Default import or namespace import
                const defaultImport = imp.descendantsOfType('identifier');
                for (const id of defaultImport) {
                    // Only direct children of import_clause
                    if (id.parent && (id.parent.type === 'import_clause' || id.parent.type === 'import_statement')) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: `${moduleName}::default`,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                        break;
                    }
                }

                // Namespace import (import * as x)
                const nsImports = imp.descendantsOfType('namespace_import');
                for (let i = 0; i < nsImports.length; i++) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: `${moduleName}::*`,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            // Export statements
            const exports = rootNode.descendantsOfType('export_statement');
            for (const exp of exports) {
                // Named export: export { x, y }
                const specifiers = exp.descendantsOfType('export_specifier');
                for (const spec of specifiers) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text || spec.text;
                    relations.push({
                        source_key: sourceKey,
                        target_name: name,
                        relation_type: 'exports' as StructuralRelationType,
                    });
                }
                // export default / export function / export class / export const
                for (let i = 0; i < exp.namedChildCount; i++) {
                    const child = exp.namedChild(i);
                    if (!child) continue;
                    if (child.type === 'function_declaration' || child.type === 'class_declaration' ||
                        child.type === 'interface_declaration' || child.type === 'enum_declaration' ||
                        child.type === 'type_alias_declaration') {
                        const name = child.childForFieldName('name')?.text;
                        if (name) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: name,
                                relation_type: 'exports' as StructuralRelationType,
                            });
                        }
                    }
                    if (child.type === 'lexical_declaration') {
                        for (let j = 0; j < child.namedChildCount; j++) {
                            const decl = child.namedChild(j);
                            if (decl && decl.type === 'variable_declarator') {
                                const name = decl.childForFieldName('name')?.text;
                                if (name) {
                                    relations.push({
                                        source_key: sourceKey,
                                        target_name: name,
                                        relation_type: 'exports' as StructuralRelationType,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            break;
        }
        case 'python': {
            // import x, import x.y
            const importStmts = rootNode.descendantsOfType('import_statement');
            for (const imp of importStmts) {
                const nameNodes = imp.descendantsOfType('dotted_name');
                for (const nameNode of nameNodes) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            // from x import y
            const fromImports = rootNode.descendantsOfType('import_from_statement');
            for (const imp of fromImports) {
                const moduleNode = imp.childForFieldName('module_name');
                const moduleName = moduleNode?.text || '';
                const nameNodes = imp.descendantsOfType('dotted_name');
                for (const nameNode of nameNodes) {
                    if (nameNode === moduleNode) continue;
                    relations.push({
                        source_key: sourceKey,
                        target_name: moduleName ? `${moduleName}.${nameNode.text}` : nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
                // Import identifiers (non-dotted)
                const idNodes = imp.descendantsOfType('identifier');
                for (const id of idNodes) {
                    // Skip if this is the module name's identifier
                    if (id.parent === moduleNode || id.parent?.parent === moduleNode) continue;
                    // Only direct imports, not aliases
                    if (id.parent && (id.parent.type === 'import_from_statement' || id.parent.type === 'aliased_import')) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: moduleName ? `${moduleName}.${id.text}` : id.text,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                    }
                }
            }
            break;
        }
        case 'cpp': {
            const includes = rootNode.descendantsOfType('preproc_include');
            for (const inc of includes) {
                // The path can be a string_literal or system_lib_string
                const pathNode = inc.childForFieldName('path');
                const path = pathNode?.text?.replace(/[<>"]/g, '') || '';
                if (path) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: path,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            break;
        }
        case 'go': {
            const importDecls = rootNode.descendantsOfType('import_declaration');
            for (const imp of importDecls) {
                const specNodes = imp.descendantsOfType('import_spec');
                for (const spec of specNodes) {
                    const pathNode = spec.childForFieldName('path');
                    const importPath = pathNode?.text?.replace(/"/g, '') || '';
                    if (importPath) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: importPath,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                    }
                }
                // Single import without spec list (import "fmt")
                const stringLiterals = imp.descendantsOfType('interpreted_string_literal');
                for (const sl of stringLiterals) {
                    // Only if not already captured via import_spec
                    if (sl.parent?.type !== 'import_spec') {
                        const importPath = sl.text.replace(/"/g, '');
                        if (importPath) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: importPath,
                                relation_type: 'imports' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'rust': {
            // Rust use declarations at module level
            const useDecls = rootNode.descendantsOfType('use_declaration');
            for (const useDecl of useDecls) {
                const argument = useDecl.childForFieldName('argument');
                if (argument) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: argument.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            break;
        }
        case 'java': {
            const importDecls = rootNode.descendantsOfType('import_declaration');
            for (const imp of importDecls) {
                // import com.example.Class; or import com.example.*;
                const nameNodes = imp.descendantsOfType('scoped_identifier');
                for (const nameNode of nameNodes) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
                // Also check for identifier (simple imports)
                if (nameNodes.length === 0) {
                    const ids = imp.descendantsOfType('identifier');
                    for (const id of ids) {
                        if (id.parent === imp) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: id.text,
                                relation_type: 'imports' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'csharp': {
            // using directives
            const usingDirectives = rootNode.descendantsOfType('using_directive');
            for (const ud of usingDirectives) {
                const nameNode = ud.childForFieldName('name') || ud.namedChild(0);
                if (nameNode) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            break;
        }
        case 'ruby': {
            // require and require_relative
            // These appear as call nodes with 'require' or 'require_relative' identifiers
            const calls = rootNode.descendantsOfType('call');
            for (const callNode of calls) {
                const methodNode = callNode.childForFieldName('method');
                if (methodNode && (methodNode.text === 'require' || methodNode.text === 'require_relative')) {
                    const args = callNode.childForFieldName('arguments');
                    if (args && args.namedChildCount > 0) {
                        const arg = args.namedChild(0);
                        const path = arg?.text?.replace(/['"]/g, '') || '';
                        if (path) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: path,
                                relation_type: 'imports' as StructuralRelationType,
                            });
                        }
                    }
                }
                // include/extend in Ruby modules
                if (methodNode && (methodNode.text === 'include' || methodNode.text === 'extend' || methodNode.text === 'prepend')) {
                    const args = callNode.childForFieldName('arguments');
                    if (args) {
                        for (let i = 0; i < args.namedChildCount; i++) {
                            const arg = args.namedChild(i);
                            if (arg) {
                                relations.push({
                                    source_key: sourceKey,
                                    target_name: arg.text,
                                    relation_type: methodNode.text === 'include' ? 'inherits' as StructuralRelationType : 'imports' as StructuralRelationType,
                                });
                            }
                        }
                    }
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Inheritance / implements relation extraction
// ---------------------------------------------------------------------------

function extractInheritanceRelations(
    node: SyntaxNode,
    stableKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    switch (language) {
        case 'typescript':
        case 'javascript': {
            if (node.type === 'class_declaration') {
                // extends clause
                const heritage = node.descendantsOfType('class_heritage');
                for (const h of heritage) {
                    // extends
                    const extendsClause = h.descendantsOfType('extends_clause');
                    for (const ext of extendsClause) {
                        const typeNode = ext.namedChild(0);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }

                // implements
                const implementsClauses = node.descendantsOfType('implements_clause');
                for (const impl of implementsClauses) {
                    for (let i = 0; i < impl.namedChildCount; i++) {
                        const typeNode = impl.namedChild(i);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'implements' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            if (node.type === 'interface_declaration') {
                // extends
                const extendsClause = node.descendantsOfType('extends_type_clause');
                for (const ext of extendsClause) {
                    for (let i = 0; i < ext.namedChildCount; i++) {
                        const typeNode = ext.namedChild(i);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'python': {
            if (node.type === 'class_definition') {
                const superclasses = node.childForFieldName('superclasses');
                if (superclasses) {
                    for (let i = 0; i < superclasses.namedChildCount; i++) {
                        const base = superclasses.namedChild(i);
                        if (base) {
                            relations.push({
                                source_key: stableKey,
                                target_name: base.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'cpp': {
            if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
                // base_class_clause contains the list of base classes
                const baseClauses = node.descendantsOfType('base_class_clause');
                for (const clause of baseClauses) {
                    for (let i = 0; i < clause.namedChildCount; i++) {
                        const child = clause.namedChild(i);
                        if (!child) continue;
                        // Each base is typically a type_identifier or qualified_identifier
                        // wrapped in a base_specifier (with optional access specifier)
                        const typeId = findDescendantByType(child, 'type_identifier') ||
                                       findDescendantByType(child, 'qualified_identifier');
                        if (typeId) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeId.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'go': {
            // Go doesn't have explicit inheritance, but struct embedding acts like it
            // and interface embedding is similar
            if (node.type === 'type_spec') {
                const typeNode = node.childForFieldName('type');
                if (typeNode && typeNode.type === 'struct_type') {
                    // Look for embedded fields (fields without a name, just a type)
                    const fieldDecls = typeNode.descendantsOfType('field_declaration');
                    for (const field of fieldDecls) {
                        // An embedded field has no name field but has a type field
                        const nameNode = field.childForFieldName('name');
                        const typeField = field.childForFieldName('type');
                        if (!nameNode && typeField) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeField.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
                if (typeNode && typeNode.type === 'interface_type') {
                    // Embedded interfaces
                    for (let i = 0; i < typeNode.namedChildCount; i++) {
                        const child = typeNode.namedChild(i);
                        if (child && child.type === 'type_identifier') {
                            relations.push({
                                source_key: stableKey,
                                target_name: child.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                        if (child && child.type === 'qualified_type') {
                            relations.push({
                                source_key: stableKey,
                                target_name: child.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'rust': {
            if (node.type === 'impl_item') {
                // impl Trait for Type
                const traitNode = node.childForFieldName('trait');
                const typeNode = node.childForFieldName('type');
                if (traitNode && typeNode) {
                    relations.push({
                        source_key: stableKey,
                        target_name: traitNode.text,
                        relation_type: 'implements' as StructuralRelationType,
                    });
                }
            }
            if (node.type === 'trait_item') {
                // Trait bounds / supertraits
                const bounds = node.childForFieldName('bounds');
                if (bounds) {
                    for (let i = 0; i < bounds.namedChildCount; i++) {
                        const bound = bounds.namedChild(i);
                        if (bound) {
                            relations.push({
                                source_key: stableKey,
                                target_name: bound.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'java': {
            if (node.type === 'class_declaration') {
                // extends
                const superclass = node.childForFieldName('superclass');
                if (superclass) {
                    relations.push({
                        source_key: stableKey,
                        target_name: superclass.text,
                        relation_type: 'inherits' as StructuralRelationType,
                    });
                }
                // implements
                const interfaces = node.childForFieldName('interfaces');
                if (interfaces) {
                    const typeList = interfaces.descendantsOfType?.('type_identifier') || [];
                    for (const ti of typeList) {
                        relations.push({
                            source_key: stableKey,
                            target_name: ti.text,
                            relation_type: 'implements' as StructuralRelationType,
                        });
                    }
                    // Also check generic types
                    const genericTypes = interfaces.descendantsOfType?.('generic_type') || [];
                    for (const gt of genericTypes) {
                        relations.push({
                            source_key: stableKey,
                            target_name: gt.text,
                            relation_type: 'implements' as StructuralRelationType,
                        });
                    }
                }
            }
            if (node.type === 'interface_declaration') {
                // extends
                const extendsInterfaces = node.childForFieldName('extends_interfaces');
                if (extendsInterfaces) {
                    const typeList = extendsInterfaces.descendantsOfType?.('type_identifier') || [];
                    for (const ti of typeList) {
                        relations.push({
                            source_key: stableKey,
                            target_name: ti.text,
                            relation_type: 'inherits' as StructuralRelationType,
                        });
                    }
                }
            }
            break;
        }
        case 'csharp': {
            if (node.type === 'class_declaration' || node.type === 'struct_declaration' || node.type === 'interface_declaration') {
                // Base list
                const baseList = node.childForFieldName('bases');
                if (baseList) {
                    for (let i = 0; i < baseList.namedChildCount; i++) {
                        const base = baseList.namedChild(i);
                        if (base) {
                            // First base is typically the class (inherits), rest are interfaces (implements)
                            const relType = (node.type === 'interface_declaration' || i > 0)
                                ? 'implements' as StructuralRelationType
                                : 'inherits' as StructuralRelationType;
                            relations.push({
                                source_key: stableKey,
                                target_name: base.text,
                                relation_type: relType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'ruby': {
            if (node.type === 'class') {
                const superclass = node.childForFieldName('superclass');
                if (superclass) {
                    relations.push({
                        source_key: stableKey,
                        target_name: superclass.text,
                        relation_type: 'inherits' as StructuralRelationType,
                    });
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Symbol node type sets per language
// ---------------------------------------------------------------------------

const TS_SYMBOL_TYPES = new Set([
    'function_declaration', 'method_definition', 'class_declaration',
    'interface_declaration', 'enum_declaration', 'type_alias_declaration',
    'arrow_function', 'lexical_declaration', 'export_statement',
]);

const PYTHON_SYMBOL_TYPES = new Set([
    'function_definition', 'class_definition', 'decorated_definition',
]);

const CPP_SYMBOL_TYPES = new Set([
    'function_definition', 'class_specifier', 'struct_specifier',
    'enum_specifier', 'namespace_definition', 'template_declaration',
]);

const GO_SYMBOL_TYPES = new Set([
    'function_declaration', 'method_declaration', 'type_declaration',
    'const_declaration', 'var_declaration',
]);

const RUST_SYMBOL_TYPES = new Set([
    'function_item', 'impl_item', 'struct_item', 'enum_item',
    'trait_item', 'mod_item', 'const_item', 'static_item',
    'type_item', 'macro_definition',
]);

const JAVA_SYMBOL_TYPES = new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'enum_declaration', 'constructor_declaration', 'field_declaration',
    'annotation_type_declaration',
]);

const CSHARP_SYMBOL_TYPES = new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'struct_declaration', 'enum_declaration', 'property_declaration',
    'delegate_declaration', 'namespace_declaration',
]);

const RUBY_SYMBOL_TYPES = new Set([
    'method', 'singleton_method', 'class', 'module',
]);

const KOTLIN_SYMBOL_TYPES = new Set([
    'function_declaration', 'class_declaration', 'object_declaration',
    'interface_declaration', 'property_declaration', 'companion_object',
]);

const SWIFT_SYMBOL_TYPES = new Set([
    'function_declaration', 'class_declaration', 'struct_declaration',
    'protocol_declaration', 'enum_declaration', 'extension_declaration',
    'typealias_declaration',
]);

const PHP_SYMBOL_TYPES = new Set([
    'function_definition', 'method_declaration', 'class_declaration',
    'interface_declaration', 'trait_declaration', 'enum_declaration',
    'namespace_definition',
]);

const BASH_SYMBOL_TYPES = new Set([
    'function_definition',
]);

function getSymbolTypeSet(language: SupportedLanguage): Set<string> {
    switch (language) {
        case 'typescript':
        case 'javascript':
            return TS_SYMBOL_TYPES;
        case 'python':
            return PYTHON_SYMBOL_TYPES;
        case 'cpp':
            return CPP_SYMBOL_TYPES;
        case 'go':
            return GO_SYMBOL_TYPES;
        case 'rust':
            return RUST_SYMBOL_TYPES;
        case 'java':
            return JAVA_SYMBOL_TYPES;
        case 'csharp':
            return CSHARP_SYMBOL_TYPES;
        case 'ruby':
            return RUBY_SYMBOL_TYPES;
        case 'kotlin':
            return KOTLIN_SYMBOL_TYPES;
        case 'swift':
            return SWIFT_SYMBOL_TYPES;
        case 'php':
            return PHP_SYMBOL_TYPES;
        case 'bash':
            return BASH_SYMBOL_TYPES;
        default:
            return new Set();
    }
}

// ---------------------------------------------------------------------------
// Main CST walker
// ---------------------------------------------------------------------------

interface WalkContext {
    filePath: string;
    language: SupportedLanguage;
    source: string;
    symbols: ExtractedSymbol[];
    relations: ExtractedRelation[];
    behaviorHints: BehaviorHint[];
    contractHints: ContractHint[];
    uncertaintyFlags: string[];
    symbolTypeSet: Set<string>;
}

function walkNode(
    node: SyntaxNode,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: SyntaxNode | null,
): void {
    if (!node || !node.type) return;

    const nodeType = node.type;
    const lang = ctx.language;

    // --- TypeScript/JavaScript-specific handling ---
    if (lang === 'typescript' || lang === 'javascript') {
        // export_statement wraps declarations — extract the inner declaration
        if (nodeType === 'export_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child) continue;
                // Recurse into the child declaration, it will be extracted as a symbol
                if (child.type === 'function_declaration' || child.type === 'class_declaration' ||
                    child.type === 'interface_declaration' || child.type === 'type_alias_declaration' ||
                    child.type === 'enum_declaration' || child.type === 'lexical_declaration') {
                    walkNode(child, ctx, parentName, parentClassNode);
                }
            }
            return;
        }

        // lexical_declaration (const/let/var) — extract individual declarators
        if (nodeType === 'lexical_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const declarator = node.namedChild(i);
                if (!declarator || declarator.type !== 'variable_declarator') continue;
                const nameNode = declarator.childForFieldName('name');
                const name = nameNode?.text;
                if (!name) continue;

                const stableKey = makeStableKey(ctx.filePath, parentName, name);
                const fullText = node.text;
                const sExpr = node.toString();

                // Determine if this is a function-valued variable
                const valueNode = declarator.childForFieldName('value');
                const isFuncLike = valueNode && (
                    valueNode.type === 'arrow_function' ||
                    valueNode.type === 'function_expression' ||
                    valueNode.type === 'function'
                );

                const kind = isFuncLike ? 'function' : 'variable';

                // Determine visibility
                const isExported = node.parent?.type === 'export_statement';
                const visibility = isExported ? 'public' : detectVisibility(node, ctx.source, lang, parentClassNode);

                ctx.symbols.push({
                    stable_key: stableKey,
                    canonical_name: name,
                    kind,
                    range_start_line: node.startPosition.row + 1,
                    range_start_col: node.startPosition.column + 1,
                    range_end_line: node.endPosition.row + 1,
                    range_end_col: node.endPosition.column + 1,
                    signature: extractTSSignature(declarator),
                    ast_hash: sha256(sExpr),
                    body_hash: sha256(fullText),
                    normalized_ast_hash: computeNormalizedAstHash(fullText, ctx.language),
                    summary: extractLeadingComment(node, ctx.source),
                    visibility,
                });

                // Behavior hints for function-like variables (AST-aware + language-gated)
                if (isFuncLike) {
                    extractBehaviorHints(fullText, stableKey, node.startPosition.row + 1, ctx.behaviorHints, valueNode, ctx.language);
                    extractContractHint(declarator, stableKey, lang, ctx.contractHints);
                    extractRelationsFromNode(valueNode, stableKey, lang, ctx.relations);
                }
            }
            return;
        }

        // function_declaration, class_declaration, interface_declaration, etc.
        if (nodeType === 'function_declaration' || nodeType === 'function_signature') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Extract inheritance
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for methods
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'interface_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            return;
        }

        if (nodeType === 'type_alias_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'enum_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'method_definition' || nodeType === 'method_signature') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        // Default: recurse into children
        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Python-specific handling ---
    if (lang === 'python') {
        if (nodeType === 'decorated_definition') {
            const definition = node.childForFieldName('definition');
            if (definition) {
                // Extract decorators for contract hints later
                const name = getNodeName(definition, lang);
                if (name) {
                    // We emit the decorated_definition itself as the symbol
                    // so decorators are included in the text
                    emitSymbol(node, name, ctx, parentName, parentClassNode);

                    if (definition.type === 'class_definition') {
                        const stableKey = makeStableKey(ctx.filePath, parentName, name);
                        extractInheritanceRelations(definition, stableKey, lang, ctx.relations);
                        // Recurse into class body
                        const body = definition.childForFieldName('body');
                        if (body) {
                            for (let i = 0; i < body.namedChildCount; i++) {
                                const member = body.namedChild(i);
                                if (member) walkNode(member, ctx, name, definition);
                            }
                        }
                    }
                    return;
                }
            }
            recurseChildren(node, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'function_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }

            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for methods
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- C++-specific handling ---
    if (lang === 'cpp') {
        if (nodeType === 'function_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_specifier' || nodeType === 'struct_specifier') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for member functions
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'enum_specifier') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'namespace_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Recurse into namespace body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'template_declaration') {
            // Find the inner declaration (function_definition, class_specifier, etc.)
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child || child.type === 'template_parameter_list') continue;
                // Extract using the template_declaration node itself for the full text/signature
                const innerName = getNodeName(child, lang);
                if (innerName) {
                    emitSymbol(node, innerName, ctx, parentName, parentClassNode);
                    if (child.type === 'class_specifier' || child.type === 'struct_specifier') {
                        const stableKey = makeStableKey(ctx.filePath, parentName, innerName);
                        extractInheritanceRelations(child, stableKey, lang, ctx.relations);
                        const body = child.childForFieldName('body');
                        if (body) {
                            for (let j = 0; j < body.namedChildCount; j++) {
                                const member = body.namedChild(j);
                                if (member) walkNode(member, ctx, innerName, child);
                            }
                        }
                    }
                    return;
                }
            }
            recurseChildren(node, ctx, parentName, parentClassNode);
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Go-specific handling ---
    if (lang === 'go') {
        if (nodeType === 'function_declaration' || nodeType === 'method_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'type_declaration') {
            // type_declaration wraps type_spec nodes
            for (let i = 0; i < node.namedChildCount; i++) {
                const typeSpec = node.namedChild(i);
                if (!typeSpec || typeSpec.type !== 'type_spec') continue;
                const name = getNodeName(typeSpec, lang);
                if (!name) continue;
                emitSymbol(typeSpec, name, ctx, parentName, parentClassNode);
                const stableKey = makeStableKey(ctx.filePath, parentName, name);
                extractInheritanceRelations(typeSpec, stableKey, lang, ctx.relations);
            }
            return;
        }

        if (nodeType === 'const_declaration' || nodeType === 'var_declaration') {
            // These may contain multiple specs
            const specs = node.descendantsOfType(
                nodeType === 'const_declaration' ? 'const_spec' : 'var_spec'
            );
            if (specs.length > 0) {
                for (const spec of specs) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text;
                    if (!name) continue;
                    emitSymbol(spec, name, ctx, parentName, parentClassNode);
                }
            } else {
                // Single-line declaration without spec wrapper — fallback
                const nameNodes = node.descendantsOfType('identifier');
                const firstNameNode = nameNodes[0];
                if (firstNameNode) {
                    const name = firstNameNode.text;
                    if (name) {
                        emitSymbol(node, name, ctx, parentName, parentClassNode);
                    }
                }
            }
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Rust-specific handling ---
    if (lang === 'rust') {
        if (nodeType === 'function_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'struct_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'enum_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'trait_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into trait body for method signatures
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'impl_item') {
            // impl Type or impl Trait for Type
            const typeNode = node.childForFieldName('type');
            const traitNode = node.childForFieldName('trait');
            const implName = typeNode?.text || 'anonymous_impl';
            const stableKey = makeStableKey(ctx.filePath, parentName, implName);

            // Register impl as a symbol
            emitSymbol(node, implName, ctx, parentName, parentClassNode);

            // Register implements relation
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);

            // Recurse into impl body for methods
            const body = node.childForFieldName('body');
            if (body) {
                const implParentName = traitNode
                    ? `${implName}(${traitNode.text})`
                    : implName;
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, implParentName, node);
                }
            }
            return;
        }

        if (nodeType === 'mod_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'const_item' || nodeType === 'static_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'type_item') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'macro_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Java-specific handling ---
    if (lang === 'java') {
        if (nodeType === 'method_declaration' || nodeType === 'constructor_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'interface_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into interface body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'enum_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Recurse into enum body for methods
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'field_declaration') {
            // Extract field names from declarators
            const declarators = node.descendantsOfType('variable_declarator');
            for (const decl of declarators) {
                const nameNode = decl.childForFieldName('name');
                const name = nameNode?.text;
                if (name) {
                    emitSymbol(node, name, ctx, parentName, parentClassNode);
                }
            }
            if (declarators.length === 0) {
                const name = getNodeName(node, lang);
                if (name) emitSymbol(node, name, ctx, parentName, parentClassNode);
            }
            return;
        }

        if (nodeType === 'annotation_type_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- C#-specific handling ---
    if (lang === 'csharp') {
        if (nodeType === 'method_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_declaration' || nodeType === 'struct_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'interface_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into interface body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'enum_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'namespace_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Recurse into namespace body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'property_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'delegate_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Ruby-specific handling ---
    if (lang === 'ruby') {
        if (nodeType === 'method' || nodeType === 'singleton_method') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'module') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Recurse into module body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Generic handler for Kotlin, Swift, PHP, Bash, and future languages ---
    // Uses the symbol type set to auto-detect what to extract without
    // per-language case blocks. This provides immediate production-grade
    // support for any language with a tree-sitter grammar.
    if (ctx.symbolTypeSet.has(nodeType)) {
        const name = getNodeName(node, lang);
        if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
        emitSymbol(node, name, ctx, parentName, parentClassNode);

        // If it's a class-like or module-like node, recurse into its body
        const kind = classifyKind(node, lang);
        if (kind === 'class' || kind === 'interface' || kind === 'module' || kind === 'enum') {
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Try to find body/member container and recurse into it
            const body = node.childForFieldName('body') ||
                         node.childForFieldName('class_body') ||
                         node.childForFieldName('members');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
        }
        return;
    }

    // Fallback: recurse into children for unknown node types
    recurseChildren(node, ctx, parentName, parentClassNode);
}

function recurseChildren(
    node: SyntaxNode,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: SyntaxNode | null,
): void {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walkNode(child, ctx, parentName, parentClassNode);
    }
}

/**
 * Emit a symbol into the context's symbols array, along with behavior hints,
 * contract hints, and call relations.
 */
function emitSymbol(
    node: SyntaxNode,
    name: string,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: SyntaxNode | null,
): void {
    const stableKey = makeStableKey(ctx.filePath, parentName, name);
    const fullText = node.text as string;
    const sExpr = node.toString();
    const kind = classifyKind(node, ctx.language);

    // Determine visibility
    let visibility: string;
    if (ctx.language === 'typescript' || ctx.language === 'javascript') {
        const isExported = node.parent?.type === 'export_statement';
        visibility = isExported ? 'public' : detectVisibility(node, ctx.source, ctx.language, parentClassNode);
    } else {
        visibility = detectVisibility(node, ctx.source, ctx.language, parentClassNode);
    }

    // For methods inside a class, override kind to 'method' across all languages
    let effectiveKind = kind;
    if (parentName !== null && kind === 'function') {
        const methodLangs: SupportedLanguage[] = ['python', 'cpp', 'rust', 'ruby'];
        if (methodLangs.includes(ctx.language)) {
            effectiveKind = 'method';
        }
    }
    // Java/C# constructor and method declarations already classified as 'method' by classifyKind

    ctx.symbols.push({
        stable_key: stableKey,
        canonical_name: name,
        kind: effectiveKind,
        range_start_line: node.startPosition.row + 1,
        range_start_col: node.startPosition.column + 1,
        range_end_line: node.endPosition.row + 1,
        range_end_col: node.endPosition.column + 1,
        signature: extractSignature(node, ctx.language),
        ast_hash: sha256(sExpr),
        body_hash: sha256(fullText),
        normalized_ast_hash: computeNormalizedAstHash(fullText, ctx.language),
        summary: extractLeadingComment(node, ctx.source),
        visibility,
    });

    // Behavior hints for functions, methods, and function-valued variables (AST-aware + language-gated)
    if (effectiveKind === 'function' || effectiveKind === 'method') {
        extractBehaviorHints(fullText, stableKey, node.startPosition.row + 1, ctx.behaviorHints, node, ctx.language);
        extractContractHint(node, stableKey, ctx.language, ctx.contractHints);
        extractRelationsFromNode(node, stableKey, ctx.language, ctx.relations);
    }
}

// ---------------------------------------------------------------------------
// Error counting
// ---------------------------------------------------------------------------

function countErrors(node: SyntaxNode): number {
    let count = 0;
    if (node.isError || node.isMissing) count++;
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) count += countErrors(child);
    }
    return count;
}

// ---------------------------------------------------------------------------
// The UniversalAdapter class
// ---------------------------------------------------------------------------

export class UniversalAdapter {
    private readonly log: Logger;

    constructor() {
        this.log = new Logger('universal-adapter');
    }

    /**
     * Parse source code with tree-sitter and extract symbols, relations,
     * behavior hints, and contract hints.
     *
     * @param filePath - Relative or absolute path to the source file (used for stable keys)
     * @param source - The raw source code text
     * @param language - The language of the source code
     * @returns AdapterExtractionResult with all extracted data
     */
    public extract(
        filePath: string,
        source: string,
        language: SupportedLanguage,
    ): AdapterExtractionResult {
        const timer = this.log.startTimer('extract', { filePath, language });

        const symbols: ExtractedSymbol[] = [];
        const relations: ExtractedRelation[] = [];
        const behaviorHints: BehaviorHint[] = [];
        const contractHints: ContractHint[] = [];
        const uncertaintyFlags: string[] = [];

        // Handle empty source
        if (!source || source.trim().length === 0) {
            timer({ symbols: 0 });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 1.0,
                uncertainty_flags: ['empty_file'],
            };
        }

        // Parse
        let tree: TreeSitterTree;
        try {
            const parser = getParser(language);
            tree = parser.parse(source);
        } catch (err) {
            this.log.error('tree-sitter parse failed', err, { filePath, language });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 0.0,
                uncertainty_flags: ['parse_failure'],
            };
        }

        const rootNode = tree.rootNode;
        if (!rootNode) {
            this.log.warn('tree-sitter returned no root node', { filePath });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 0.0,
                uncertainty_flags: ['no_root_node'],
            };
        }

        // Count parse errors for confidence scoring
        const errorCount = countErrors(rootNode);
        if (errorCount > 0) {
            uncertaintyFlags.push('parse_errors');
            this.log.debug('Parse errors detected', { filePath, errorCount });
        }

        // Build walk context
        const ctx: WalkContext = {
            filePath,
            language,
            source,
            symbols,
            relations,
            behaviorHints,
            contractHints,
            uncertaintyFlags,
            symbolTypeSet: getSymbolTypeSet(language),
        };

        // Walk the CST for symbols, behavior, contracts
        try {
            for (let i = 0; i < rootNode.namedChildCount; i++) {
                const child = rootNode.namedChild(i);
                if (child) walkNode(child, ctx, null, null);
            }
        } catch (err) {
            this.log.error('CST walk failed', err, { filePath, language });
            uncertaintyFlags.push('walk_failure');
        }

        // Extract import/export relations (module-level)
        try {
            extractImportRelations(rootNode, filePath, language, relations);
        } catch (err) {
            this.log.error('Import extraction failed', err, { filePath, language });
            uncertaintyFlags.push('import_extraction_failure');
        }

        // Deduplicate relations
        const deduplicatedRelations = deduplicateRelations(relations);

        // Compute parse confidence
        const totalNodes = rootNode.descendantCount || 1;
        let parseConfidence: number;
        if (errorCount === 0) {
            parseConfidence = 1.0;
        } else {
            // Reduce confidence proportionally to error ratio, with a floor of 0.3
            const errorRatio = errorCount / totalNodes;
            parseConfidence = Math.max(0.3, 1.0 - errorRatio * 5);
        }

        const result: AdapterExtractionResult = {
            symbols,
            relations: deduplicatedRelations,
            behavior_hints: behaviorHints,
            contract_hints: contractHints,
            parse_confidence: Math.round(parseConfidence * 100) / 100,
            uncertainty_flags: [...new Set(uncertaintyFlags)],
        };

        timer({
            symbols: symbols.length,
            relations: deduplicatedRelations.length,
            behavior_hints: behaviorHints.length,
            contract_hints: contractHints.length,
            parse_confidence: result.parse_confidence,
        });

        return result;
    }
}

/**
 * Deduplicate relations by (source_key, target_name, relation_type).
 */
function deduplicateRelations(relations: ExtractedRelation[]): ExtractedRelation[] {
    const seen = new Set<string>();
    const result: ExtractedRelation[] = [];
    for (const rel of relations) {
        const key = `${rel.source_key}|${rel.target_name}|${rel.relation_type}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(rel);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Parse source code with tree-sitter and extract symbols, relations,
 * behavior hints, and contract hints.
 *
 * This is a convenience wrapper around UniversalAdapter.extract().
 */
export function extractWithTreeSitter(
    filePath: string,
    source: string,
    language: SupportedLanguage,
): AdapterExtractionResult {
    const adapter = new UniversalAdapter();
    return adapter.extract(filePath, source, language);
}
