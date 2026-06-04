---
title: "Android In-App Search: From FTS Full-Text Indexing to Compose Search UI"
lang: en
translationKey: android-in-app-search-fts
slug: android-in-app-search-fts
excerpt: "A full-stack walkthrough of Android in-app search optimization, from SQLite FTS5 indexes and Room integration to debounced Compose search that reduced response time from 1.8 seconds to 15 ms."
publishDate: '2026-04-01'
tags:
- "Android"
- "Room"
- "Jetpack Compose"
- "FTS5"
- "Full-Text Search"
seo:
  title: "Android In-App Search with SQLite FTS5, Room, and Compose"
  description: "A practical guide to Android in-app search optimization using SQLite FTS5, Room integration, debounce, highlighting, and Compose state handling."
  pageType: article
---

Last year I worked on performance optimization for a local note-taking app. Users reported that search was too slow: with only 2,000 notes, entering a keyword took 2-3 seconds before results appeared. The database was using a simple `LIKE '%keyword%'` query, which became unusable once the dataset grew.

After the rewrite, search response time dropped below 50 ms. The idea was not complicated, but it required several layers to work together. This article walks through the full path.

## Why LIKE queries collapse at scale

Start with a typical search implementation:

```sql
SELECT * FROM notes WHERE content LIKE '%keyword%' OR title LIKE '%keyword%';
```

This query has two problems. First, the leading wildcard in `LIKE '%keyword%'` makes a B-tree index useless, so SQLite has to scan the whole table. Second, CJK word segmentation is not a good fit for simple pattern matching. A user expects a query such as "performance optimization" to match a note titled "Android performance optimization practices," but naive string matching often fails to model that intent.

**Full-Text Search, or FTS**, solves this class of problem. Instead of comparing strings row by row, it builds an inverted index ahead of time: each document is split into terms, and the index records which documents contain each term.

## Core mechanics of SQLite FTS5

FTS5 is SQLite's built-in full-text search engine. It shipped with SQLite 3.9.0 in 2015 and is now a standard feature in Android's default SQLite versions.

### Table creation and indexing

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content,
    tokenize='unicode61'
);
```

`VIRTUAL TABLE` means the FTS table does not store the original data directly. It stores the inverted index. When you insert a row, the FTS engine performs tokenization, removes stop words, and builds the index:

```sql
INSERT INTO notes_fts(title, content) VALUES (
    'Android Bitmap memory optimization',
    'Bitmap memory is allocated on the Java heap and can easily trigger OOM...'
);
```

`tokenize='unicode61'` selects the tokenizer. `unicode61` is the default FTS5 tokenizer. It tokenizes text according to the Unicode 6.1 standard. It works naturally for English, where spaces and punctuation mark word boundaries, but its CJK support is rough because it has no built-in dictionary for those languages. For CJK-heavy search, prefer the `icu` tokenizer or integrate a third-party tokenizer through a custom Tokenizer.

### Three matching modes

```sql
-- 1. MATCH: the core query path using the inverted index
SELECT * FROM notes_fts WHERE notes_fts MATCH 'bitmap memory';

-- 2. BM25 ranking: order by relevance
SELECT *, bm25(notes_fts) AS score
FROM notes_fts
WHERE notes_fts MATCH 'memory optimization'
ORDER BY score;

-- 3. Prefix query: live completion while the user types
SELECT * FROM notes_fts WHERE notes_fts MATCH 'bit*';
```

`MATCH` uses the inverted index internally, so its time complexity is related to the number of keyword hits rather than the total number of rows. In my test with 5,000 notes, `LIKE` averaged 1.8 seconds, while `MATCH` stayed around 2-5 ms.

BM25 is the default FTS5 ranking algorithm. It combines term frequency, inverse document frequency, and document length normalization. When searching for "memory leak," a document that repeatedly discusses the term ranks above a document that mentions it only once. That is much smarter than the boolean match behavior of `LIKE`.

## Practical FTS5 integration with Room

Using raw SQLite APIs to manage FTS tables is tedious. Table creation is special, and queries usually need to join back to the original table to fetch complete data. Room 2.2+ supports FTS natively with a few annotations.

### Two-table design: entity table and FTS table

```kotlin
@Entity(tableName = "notes")
data class Note(
    @PrimaryKey val id: Long,
    val title: String,
    val content: String,
    val updatedAt: Long
)

@Fts4(contentEntity = Note::class, tokenizer = "unicode61")
@Entity(tableName = "notes_fts")
data class NoteFts(
    @ColumnInfo(name = "title") val title: String,
    @ColumnInfo(name = "content") val content: String
)
```

There is a choice here: use `@Fts4`, or create an FTS5 table manually. Room currently exposes the `@Fts4` annotation because FTS4 and FTS5 have similar operation semantics at the Room layer. If you need FTS5-specific capabilities, such as BM25 customization, column filters, or faster rebuilds, you can use `@RawQuery` to execute DDL manually and create an FTS5 virtual table. Normal Room queries can still join that FTS5 table.

`contentEntity` means the FTS table is an index table for `Note`, and Room synchronizes writes automatically.

### Query implementation

```kotlin
@Dao
interface NoteDao {
    @Query("""
        SELECT notes.* FROM notes
        JOIN notes_fts ON notes.id = notes_fts.rowid
        WHERE notes_fts MATCH :query
        ORDER BY bm25(notes_fts)
    """)
    suspend fun search(query: String): List<Note>

    @Insert
    suspend fun insert(note: Note)
}
```

Room handles transactions, async queries, and coroutine integration for you. You do not need to manually manage `beginTransaction`, which saves a lot of work when keeping indexes synchronized.

### Incremental synchronization strategy

The FTS index does not need to be fully rebuilt on every change. Initialize the index in `onCreate`, and wrap incremental writes in `@Transaction`:

```kotlin
@Transaction
suspend fun insertWithFts(note: Note, fts: NoteFts) {
    val id = insert(note)
    // rowid aligns automatically; no explicit assignment is required
}
```

`rowid` is the implicit primary key of the FTS table. It automatically aligns with the primary key of the associated entity table as long as inserts are synchronized, so explicit assignment is not required.

## Three layers of search UX in Compose

Once the backend index is ready, frontend search UX decides whether users perceive the app as fast. I used a three-layer Compose search architecture.

### Layer 1: input debounce

Do not query while the user is still typing. Wait until typing pauses for 300 ms:

```kotlin
@Composable
fun SearchScreen(viewModel: SearchViewModel) {
    var query by remember { mutableStateOf("") }

    LaunchedEffect(query) {
        delay(300L) // debounce
        viewModel.search(query)
    }
}
```

The 300 ms delay solves two problems at the same time: it reduces useless queries, and it prevents UI flicker while results change during typing.

### Layer 2: async search and state management

```kotlin
class SearchViewModel(
    private val noteDao: NoteDao
) : ViewModel() {
    private val _searchResult = MutableStateFlow<SearchUiState>(SearchUiState.Idle)
    val searchResult = _searchResult.asStateFlow()

    fun search(query: String) {
        if (query.length < 2) {
            _searchResult.value = SearchUiState.Idle
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            val results = noteDao.search(query)
            _searchResult.value = SearchUiState.Result(results)
        }
    }
}
```

Queries shorter than two characters do not trigger search. Adjust this threshold for the product. In a note-taking app, a one-character query usually does not produce useful results.

### Layer 3: highlighting and interaction

After users see results, they need to locate the keyword quickly:

```kotlin
@Composable
fun SearchResultItem(note: Note, query: String) {
    val annotatedTitle = buildAnnotatedString {
        val lowerTitle = note.title.lowercase()
        val lowerQuery = query.lowercase()
        var start = 0
        while (true) {
            val index = lowerTitle.indexOf(lowerQuery, start)
            if (index == -1) {
                append(note.title.substring(start))
                break
            }
            append(note.title.substring(start, index))
            withStyle(SpanStyle(
                background = Color(0xFFFFEB3B), // yellow highlight
                fontWeight = FontWeight.Bold
            )) {
                append(note.title.substring(index, index + query.length))
            }
            start = index + query.length
        }
    }
    Text(text = annotatedTitle, maxLines = 1)
}
```

In production code, I prefer to move highlight generation into the ViewModel state. The Composable should render an already prepared `AnnotatedString`, keeping the UI layer pure.

## Two pitfalls I hit

**Pitfall 1: the FTS table and entity table primary keys drifted apart.** The FTS table uses `rowid` as its implicit primary key, while the entity table may use an auto-increment ID. If rows are deleted or IDs skip values, the FTS `rowid` and entity ID can stop matching. The fix is to define the FTS table with `content=` pointing to the external content table, so FTS stores only the index rather than the data. Room's `@Fts4` annotation uses `content=` mode by default and handles synchronization internally, so no extra work is needed.

**Pitfall 2: tokenization quality for CJK text.** The default `unicode61` tokenizer may split CJK text into overlapping bigrams. That makes short queries match, but the index can grow substantially: for each CJK-heavy document, the index may become 2-3 times larger than the original text. If storage is sensitive, consider `tokenize='porter unicode61'` to reduce redundancy, or integrate an external ICU-based tokenizer.

## Full-chain performance data

I compared three approaches on a test set of 5,000 CJK notes, averaging 800 characters per note:

| Approach | First search | Continuous search | Index progress |
|------|---------|---------|---------|
| LIKE full-table scan | 1800 ms | 1800 ms | None |
| FTS5 full-text index | 15 ms | 3-8 ms | Offline index |
| FTS5 plus Compose debounce | 315 ms* | 3-8 ms | Same |

\* 315 ms includes the 300 ms debounce delay. The actual query still finishes within 15 ms. To users, that delay feels like a natural pause after typing and is effectively invisible.

One final architecture tradeoff: if the dataset is below 500 rows, `LIKE` plus a simple B-tree index is often enough, and FTS may add unnecessary engineering complexity. The 500-5,000 row range is FTS's sweet spot, where the return on effort is strongest. Above 50,000 rows, consider FTS5 partitioned indexes or an external search engine such as Lucene. A single unpartitioned FTS table may no longer be enough.
