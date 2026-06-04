---
title: "Prompt Engineering: From Core Principles to Advanced Practice (2): promptfoo"
lang: en
translationKey: prompt-engineering-core-principles-part2
slug: prompt-engineering-core-principles-part2
excerpt: "Part 2 of the Prompt Engineering: From Core Principles to Advanced Practice series, focused on promptfoo."
publishDate: '2026-02-10'
displayInBlog: false
tags:
  - "AI"
  - "Prompt Engineering"
  - "LLM"
  - "Large Language Models"
series:
  name: "Prompt Engineering: From Core Principles to Advanced Practice"
  part: 2
  total: 4
seo:
  title: "Prompt Engineering Evaluation with promptfoo"
  description: "Learn how to move prompt engineering into an evaluation-driven workflow with promptfoo tests, automated assertions, and CI/CD integration."
  pageType: article
---
> This is part 2 of the four-part series "Prompt Engineering: From Core Principles to Advanced Practice." In the previous article, we covered why prompt engineering is a core capability for technical teams.

### Engineering Practice: Prompt Evaluation and Automation
In production, teams often switch models to improve quality or reduce cost. But because of how LLMs work, including probability, tokenization, and model parameters, the exact same prompt can behave very differently across models and model versions. A model migration can even cause a major quality regression.

To turn prompt engineering from an "art" into a rigorous engineering discipline, you need systematic evaluation and automation. This is not just a way to protect AI application quality; it is the core practice that makes large-scale deployment and continuous optimization possible.

#### 3.1 Prompt Evaluation: Measuring Results and Finding Problems
The fundamental goal of evaluation is to determine, objectively and quantitatively, which prompt version performs better on a specific task.

A complete evaluation system should cover several key dimensions:

- **Accuracy / Success Rate**: This is the most important metric. Define clear success criteria for the task, such as `First-try success`. This directly validates the **Easy to verify (E)** principle.
- **Efficiency / Cost**: Track `Token usage`, because it directly affects API cost and response latency. This measures the practical impact of principles such as **Keep it concise (K)** and **Narrow the scope (N)**.
- **Consistency / Reproducibility**: Measure how stable the output is for the same input. A good prompt should produce predictable results repeatedly, which maps to the **Reproducible results (R)** principle.
- **Robustness**: Evaluate how the prompt behaves under small input changes, irrelevant noise, or potential malicious attacks. For example, you can simulate different prompt injection attacks to test whether safety guardrails work.

**A/B testing** is a highly practical evaluation method. You can design a standardized test set, then run different prompt versions, such as a basic RAG template and a guardrailed RAG template, against the same cases. By comparing outputs side by side and scoring them against the dimensions above, you can decide scientifically which template is better.

##### promptfoo

promptfoo is a tool for testing prompts and agents. It can compare behavior across models and integrate into CI/CD workflows.

- https://github.com/promptfoo/promptfoo

File structure

```plain
- prompt_system.txt  // prompt text
- promptfooconfig.yaml // promptfoo configuration, including prompts
- prompt1_formatted.json // prompt configuration
```

```plain
# yaml-language-server: $schema=https://promptfoo.dev/config-schema.json

# Learn more about building a configuration: https://promptfoo.dev/docs/configuration/guide

description: "AI Stylist Intent Classification Tests"

prompts:
  - file://prompt1_formatted.json

providers:
  - "openai:gpt-4o-mini"

# Default test assertions: ensure every output is valid JSON and includes an intent field
defaultTest:
  assert:
    - type: is-json
    - type: javascript
      value: |
        const result = JSON.parse(output);
        return result.intent !== undefined;

tests:
  # 1. SEARCH_PRODUCT - text_search
  - description: "Text search for white French dress"
    vars:
      user_input: "I want to buy a white French dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'text_search' &&
                 result.entities.attributes.includes('white');

  # 2. SEARCH_PRODUCT - category match - Tops
  - description: "Category search - Tops"
    vars:
      user_input: "find some tops"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'category' &&
                 result.entities.id === '1490';

  # 3. SEARCH_PRODUCT - category match - Sale Denim
  - description: "Category search - Sale Denim"
    vars:
      user_input: "Sale Denim"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'category' &&
                 result.entities.id === '1600';

  # 4. SEARCH_PRODUCT - item_id_search, 5 characters
  - description: "Item ID search (5 characters)"
    vars:
      user_input: "88010"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'item_id_search' &&
                 result.entities.item_id === '88010';

  # 5. SEARCH_PRODUCT - order_id_search, more than 10 characters
  - description: "Order ID search (>10 characters)"
    vars:
      user_input: "1234567890123"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'order_id_search' &&
                 result.entities.order_id === '1234567890123';

  # 6. DIRECT_FUNCTION - cart navigation
  - description: "Navigate to shopping cart"
    vars:
      user_input: "I want to go to my cart"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && 
                 result.entities.router === '/cart';

  # 7. DIRECT_FUNCTION - view order list
  - description: "Check order status"
    vars:
      user_input: "where is my order?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && 
                 result.entities.router === '/order/list';

  # 8. DIRECT_FUNCTION - view specific order details
  - description: "Check specific order details"
    vars:
      user_input: "Help me check the logistics for order 1234567890123"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && 
                 result.entities.router === '/order/detail/1234567890123';

  # 9. CUSTOMER_SERVICE - Return policy, route to support
  - description: "Ask about return policy"
    vars:
      user_input: "What is your returns policy?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && 
                 Object.keys(result.entities).length === 0;

  # 10. CUSTOMER_SERVICE - Payment method, route to support
  - description: "Ask about payment methods"
    vars:
      user_input: "How can I pay for my order?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && 
                 Object.keys(result.entities).length === 0;

  # 11. FASHION_QA - Care instructions
  - description: "Ask about garment care"
    vars:
      user_input: "How do I wash a silk sari?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && 
                 result.entities.topic === 'Care Instructions';

  # 12. FASHION_QA - Styling advice
  - description: "Ask for styling advice"
    vars:
      user_input: "What is the correct way to wear a Hijab?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && 
                 result.entities.topic === 'Styling Advice';

  # 13. FASHION_QA - Term definition
  - description: "Ask about fashion term"
    vars:
      user_input: "What does Ikat mean?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && 
                 result.entities.topic === 'Term Definition';

  # 14. CUSTOMER_SERVICE - Request human agent
  - description: "Request human agent"
    vars:
      user_input: "I want to talk to a human"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && 
                 Object.keys(result.entities).length === 0;

  # 15. CUSTOMER_SERVICE - Complex query requiring a human agent
  - description: "Complex size question requiring agent"
    vars:
      user_input: "What size should I wear?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && 
                 Object.keys(result.entities).length === 0;

  # 16. AMBIGUOUS - Unclear intent
  - description: "Ambiguous intent - Return"
    vars:
      user_input: "Return"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && 
                 result.clarification_prompt !== undefined &&
                 result.clarification_prompt.length > 0;

  # ==================== SEARCH_PRODUCT extended tests (17-51) ====================

  # 17-21: More text search variants
  - description: "Search for specific color and style"
    vars:
      user_input: "Looking for a red evening gown"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with multiple attributes"
    vars:
      user_input: "I need a black leather jacket size M"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with material specification"
    vars:
      user_input: "silk scarf"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with occasion"
    vars:
      user_input: "wedding dress for summer"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with brand-like term"
    vars:
      user_input: "elegant palazzo pants"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # 22-25: Category search variants
  - description: "Category - Sale Bottoms exact match"
    vars:
      user_input: "Sale Bottoms"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'category' && 
                 result.entities.id === '1007';

  - description: "Category - lowercase variation"
    vars:
      user_input: "sale denim"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'category';

  - description: "Category - partial match"
    vars:
      user_input: "show me tops"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Category - with extra words"
    vars:
      user_input: "I want to see sale bottoms please"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  # 26-32: Item ID boundary tests
  - description: "Item ID - exactly 5 digits (pure numbers)"
    vars:
      user_input: "12345"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'item_id_search' &&
                 result.entities.item_id === '12345';

  - description: "Item ID - exactly 6 digits (pure numbers)"
    vars:
      user_input: "123456"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'item_id_search' &&
                 result.entities.item_id === '123456';

  - description: "Not Item ID - contains letters (should be text_search)"
    vars:
      user_input: "ABC123"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'text_search' &&
                 result.entities.query === 'ABC123';

  - description: "Not Item ID - alphanumeric (should be text_search)"
    vars:
      user_input: "A1B2C"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'text_search';

  - description: "Not Item ID - 4 characters (too short)"
    vars:
      user_input: "1234"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type !== 'item_id_search';

  - description: "Not Item ID - 7 characters (too long)"
    vars:
      user_input: "1234567"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type !== 'item_id_search';

  - description: "Not Item ID - mixed letters and numbers (should be text_search)"
    vars:
      user_input: "Wx89T"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Not Item ID - all letters (should be text_search)"
    vars:
      user_input: "ABCDE"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # 33-38: Order ID boundary tests
  - description: "Order ID - exactly 11 characters"
    vars:
      user_input: "12345678901"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'order_id_search' &&
                 result.entities.order_id === '12345678901';

  - description: "Order ID - 15 characters"
    vars:
      user_input: "123456789012345"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'order_id_search';

  - description: "Order ID - alphanumeric long"
    vars:
      user_input: "ORD20250131ABCD"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'order_id_search';

  - description: "Not Order ID - exactly 10 characters"
    vars:
      user_input: "1234567890"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type !== 'order_id_search';

  - description: "Order ID - very long"
    vars:
      user_input: "12345678901234567890"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && 
                 result.entities.type === 'order_id_search';

  - description: "Order ID with dashes (treated as text)"
    vars:
      user_input: "123-456-7890-12"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  # 39-44: Fuzzy search and typos
  - description: "Misspelled search term"
    vars:
      user_input: "I want to buy a beutiful dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with typo"
    vars:
      user_input: "blak jeans"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Informal search"
    vars:
      user_input: "need smth warm"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with slang"
    vars:
      user_input: "cool hoodie pls"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Very descriptive search"
    vars:
      user_input: "I'm looking for a comfortable, casual, blue cotton t-shirt"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with comparison"
    vars:
      user_input: "something like a maxi dress but shorter"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # 45-51: Image search and mixed input
  - description: "Image search indication"
    vars:
      user_input: "[Image uploaded] find this"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Image search with color request"
    vars:
      user_input: "[Image] do you have this in green?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Search by visual description"
    vars:
      user_input: "I saw a dress in your store window"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search multiple items"
    vars:
      user_input: "show me dresses and skirts"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with price indication"
    vars:
      user_input: "affordable summer dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with size in query"
    vars:
      user_input: "plus size evening gown"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Search with emoji"
    vars:
      user_input: "👗 party dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # ==================== DIRECT_FUNCTION extended tests (52-71) ====================

  - description: "Navigate to wishlist - variation 1"
    vars:
      user_input: "take me to wishlist"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/wishlist';

  - description: "Navigate to wishlist - variation 2"
    vars:
      user_input: "my favorites"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/wishlist';

  - description: "View profile"
    vars:
      user_input: "my profile"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/me';

  - description: "View account page"
    vars:
      user_input: "my account"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/me';

  - description: "Check out cart"
    vars:
      user_input: "checkout"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/cart';

  - description: "View shopping bag"
    vars:
      user_input: "my bag"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/cart';

  - description: "Go to homepage"
    vars:
      user_input: "go home"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/home';

  - description: "View categories"
    vars:
      user_input: "show all categories"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/category';

  - description: "Check my orders"
    vars:
      user_input: "my orders"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/order/list';

  - description: "View order history"
    vars:
      user_input: "order history"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/order/list';

  - description: "Track specific order - variation"
    vars:
      user_input: "track order 98765432101"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && 
                 result.entities.router.includes('/order/detail/');

  - description: "Check order status with ID"
    vars:
      user_input: "status of order 11122233344"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && 
                 result.entities.router.includes('/order/detail/');

  - description: "View coupons"
    vars:
      user_input: "show my coupons"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/member/my-coupons';

  - description: "Check discounts"
    vars:
      user_input: "my discounts"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/member/my-coupons';

  - description: "Update address"
    vars:
      user_input: "update my address"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Manage addresses"
    vars:
      user_input: "manage shipping addresses"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Change language"
    vars:
      user_input: "switch language"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Help center access"
    vars:
      user_input: "help center"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/help-center/home';

  - description: "FAQ page"
    vars:
      user_input: "frequently asked questions"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/help-center/home';

  - description: "Arabic - view cart"
    vars:
      user_input: "عربة التسوق"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION';

  # ==================== CUSTOMER_SERVICE - FAQ-related extended tests (72-86) ====================

  - description: "Return policy - variation 1"
    vars:
      user_input: "can I return items?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Return policy - variation 2"
    vars:
      user_input: "how do returns work"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Shipping inquiry"
    vars:
      user_input: "how long does shipping take?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Delivery time"
    vars:
      user_input: "when will my order arrive"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Shipping cost"
    vars:
      user_input: "is shipping free?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Payment methods accepted"
    vars:
      user_input: "what payment methods do you accept?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Can I pay with card"
    vars:
      user_input: "do you take credit cards?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Cancel order inquiry"
    vars:
      user_input: "can I cancel my order?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Modify order"
    vars:
      user_input: "I want to change my order"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Terms and conditions"
    vars:
      user_input: "what are your terms?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Privacy policy"
    vars:
      user_input: "how do you use my data?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Email verification"
    vars:
      user_input: "I didn't receive verification email"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Return window"
    vars:
      user_input: "how many days to return?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Refund process"
    vars:
      user_input: "when will I get my refund?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "International shipping"
    vars:
      user_input: "do you ship internationally?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  # ==================== FASHION_QA extended tests (87-101) ====================

  - description: "How to style jeans"
    vars:
      user_input: "how should I style skinny jeans?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Outfit combination"
    vars:
      user_input: "what goes well with a black blazer?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Color matching"
    vars:
      user_input: "what colors match with navy blue?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Seasonal styling"
    vars:
      user_input: "how to dress for fall weather?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Washing delicate fabric"
    vars:
      user_input: "how to clean cashmere sweater?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Remove stains"
    vars:
      user_input: "how to remove oil stain from dress?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Storage advice"
    vars:
      user_input: "how to store winter coats?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Ironing tips"
    vars:
      user_input: "can I iron silk blouse?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Fashion term - Bohemian"
    vars:
      user_input: "what is bohemian style?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Fashion term - A-line"
    vars:
      user_input: "what does A-line mean?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Fashion term - Palazzo"
    vars:
      user_input: "explain palazzo pants"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Current trends"
    vars:
      user_input: "what's trending this season?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  - description: "Color trends"
    vars:
      user_input: "what are the popular colors for 2025?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  - description: "Style trends"
    vars:
      user_input: "what styles are in fashion now?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  - description: "Upcoming trends"
    vars:
      user_input: "what will be trendy next spring?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  # ==================== CUSTOMER_SERVICE extended tests (102-111) ====================

  - description: "Request human - direct"
    vars:
      user_input: "speak to agent"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Request human - polite"
    vars:
      user_input: "can I talk to someone?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Request human - urgent"
    vars:
      user_input: "I need help now"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Complaint about product"
    vars:
      user_input: "This item is defective"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Complaint about delivery"
    vars:
      user_input: "my package never arrived"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Wrong item received"
    vars:
      user_input: "I received the wrong item"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Size recommendation needed"
    vars:
      user_input: "which size should I order?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Fit question"
    vars:
      user_input: 'will this fit me if I''m 5''6"?'
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Account issue"
    vars:
      user_input: "I can't log into my account"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Payment problem"
    vars:
      user_input: "my payment was declined"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  # ==================== AMBIGUOUS extended tests (112-121) ====================

  - description: "Ambiguous - single word 'Order'"
    vars:
      user_input: "Order"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'My order'"
    vars:
      user_input: "My order"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Size'"
    vars:
      user_input: "Size"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Help'"
    vars:
      user_input: "Help"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Change'"
    vars:
      user_input: "Change"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - unclear question"
    vars:
      user_input: "What about it?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - pronoun only"
    vars:
      user_input: "This one"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - incomplete sentence"
    vars:
      user_input: "I want to"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - vague intent"
    vars:
      user_input: "Something wrong"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'More'"
    vars:
      user_input: "More"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  # ==================== Boundary and edge-case tests (122-135) ====================

  - description: "Empty or whitespace only"
    vars:
      user_input: "   "
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Single character"
    vars:
      user_input: "a"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Numbers only - 3 digits"
    vars:
      user_input: "123"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Special characters"
    vars:
      user_input: "!@#$%"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Mixed languages"
    vars:
      user_input: "I want فستان dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "ALL CAPS"
    vars:
      user_input: "SHOW ME DRESSES"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "lowercase no punctuation"
    vars:
      user_input: "i need a black dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Multiple emojis"
    vars:
      user_input: "😍💃👗"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "URL in input"
    vars:
      user_input: "www.example.com/dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Email in input"
    vars:
      user_input: "user@example.com"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Very long text"
    vars:
      user_input: "I am looking for a very specific type of dress that has to be blue and elegant and suitable for a wedding ceremony and also needs to be comfortable because I will be wearing it for many hours and it should have some elegant details but not too much and the price should be reasonable"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Repeated words"
    vars:
      user_input: "dress dress dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Question mark only"
    vars:
      user_input: "???"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Greeting instead of query"
    vars:
      user_input: "Hello!"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  # ==================== SEARCH_PRODUCT deeper coverage (136-165) ====================

  # 136-145: Seasonal and occasion-based searches
  - description: "Summer collection search"
    vars:
      user_input: "summer dresses"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Winter clothing"
    vars:
      user_input: "warm winter coat"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Spring fashion"
    vars:
      user_input: "spring floral skirt"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Fall/autumn wear"
    vars:
      user_input: "autumn cardigan"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Wedding occasion"
    vars:
      user_input: "what should I wear to a wedding?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Party outfit"
    vars:
      user_input: "outfit for birthday party"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Formal event"
    vars:
      user_input: "formal business attire"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Casual everyday"
    vars:
      user_input: "casual everyday wear"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Gym/workout clothing"
    vars:
      user_input: "workout clothes for gym"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Beach vacation"
    vars:
      user_input: "beach vacation outfits"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # 146-155: Price- and size-related searches
  - description: "Budget friendly search"
    vars:
      user_input: "cheap dresses under 50"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Discount search"
    vars:
      user_input: "discounted items"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Luxury items"
    vars:
      user_input: "luxury designer dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Plus size specific"
    vars:
      user_input: "plus size maxi dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Petite size"
    vars:
      user_input: "petite jeans"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Tall size"
    vars:
      user_input: "tall pants for women"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Maternity wear"
    vars:
      user_input: "maternity dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Size range query"
    vars:
      user_input: "do you have this in XL?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Numeric size"
    vars:
      user_input: "size 12 dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "International size"
    vars:
      user_input: "EU size 40 shoes"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # 156-165: Special material and color variants
  - description: "Organic fabric"
    vars:
      user_input: "organic cotton t-shirt"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Sustainable fashion"
    vars:
      user_input: "sustainable eco-friendly clothing"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Vegan leather"
    vars:
      user_input: "vegan leather jacket"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Breathable fabric"
    vars:
      user_input: "breathable linen dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Specific color shade"
    vars:
      user_input: "navy blue blouse"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Light color variation"
    vars:
      user_input: "light pink sweater"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Dark color variation"
    vars:
      user_input: "dark green pants"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Pattern specific"
    vars:
      user_input: "striped shirt"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Print pattern"
    vars:
      user_input: "floral print dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Texture description"
    vars:
      user_input: "soft velvet top"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  # ==================== DIRECT_FUNCTION scenario expansion (166-180) ====================

  - description: "Payment method page"
    vars:
      user_input: "add payment method"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "View saved cards"
    vars:
      user_input: "my saved credit cards"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Track package"
    vars:
      user_input: "track my package"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/order/list';

  - description: "Delivery status"
    vars:
      user_input: "check delivery status"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/order/list';

  - description: "Order again"
    vars:
      user_input: "reorder previous items"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/order/list';

  - description: "Saved addresses"
    vars:
      user_input: "view saved addresses"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Add new address"
    vars:
      user_input: "add new shipping address"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Notification settings"
    vars:
      user_input: "manage notifications"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Email preferences"
    vars:
      user_input: "change email preferences"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/account/setting';

  - description: "Recently viewed"
    vars:
      user_input: "show recently viewed items"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION';

  - description: "Favorites list"
    vars:
      user_input: "my favorite items"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/wishlist';

  - description: "Main menu"
    vars:
      user_input: "show main menu"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/home';

  - description: "Back to shop"
    vars:
      user_input: "back to shopping"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/home';

  - description: "New arrivals"
    vars:
      user_input: "show new arrivals"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/category';

  - description: "Best sellers"
    vars:
      user_input: "show best sellers"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION' && result.entities.router === '/category';

  # ==================== CUSTOMER_SERVICE - detailed FAQ scenarios (181-195) ====================

  - description: "Return process steps"
    vars:
      user_input: "how do I start a return?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Exchange instead of return"
    vars:
      user_input: "can I exchange instead of returning?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Return shipping cost"
    vars:
      user_input: "do I pay for return shipping?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "International shipping cost"
    vars:
      user_input: "how much is international shipping?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Express shipping"
    vars:
      user_input: "do you offer express shipping?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Tracking number"
    vars:
      user_input: "when will I get tracking number?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "PayPal acceptance"
    vars:
      user_input: "do you accept PayPal?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Installment payment"
    vars:
      user_input: "can I pay in installments?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Gift card payment"
    vars:
      user_input: "can I use gift card?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Order cancellation time"
    vars:
      user_input: "how long do I have to cancel?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Change delivery address"
    vars:
      user_input: "can I change delivery address after ordering?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Size chart request"
    vars:
      user_input: "where is the size chart?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Gift wrapping service"
    vars:
      user_input: "do you offer gift wrapping?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Loyalty program"
    vars:
      user_input: "what is your loyalty program?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Student discount"
    vars:
      user_input: "do you have student discount?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  # ==================== FASHION_QA professional scenarios (196-210) ====================

  - description: "Fabric comparison"
    vars:
      user_input: "what's the difference between cotton and linen?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Body type styling"
    vars:
      user_input: "what should I wear for pear body shape?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Office dress code"
    vars:
      user_input: "what's appropriate for business casual?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Accessory pairing"
    vars:
      user_input: "what jewelry goes with cocktail dress?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Shoe pairing"
    vars:
      user_input: "what shoes to wear with midi skirt?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Layering advice"
    vars:
      user_input: "how to layer clothes for winter?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Styling Advice';

  - description: "Denim care"
    vars:
      user_input: "how often should I wash jeans?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Shrinkage prevention"
    vars:
      user_input: "how to prevent clothes from shrinking?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Dry cleaning"
    vars:
      user_input: "what items need dry cleaning?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Color bleeding prevention"
    vars:
      user_input: "how to prevent colors from bleeding?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Care Instructions';

  - description: "Fashion term - capsule wardrobe"
    vars:
      user_input: "what is a capsule wardrobe?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Fashion term - athleisure"
    vars:
      user_input: "explain athleisure style"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Fashion term - minimalist"
    vars:
      user_input: "what does minimalist fashion mean?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Term Definition';

  - description: "Seasonal color palette"
    vars:
      user_input: "what colors are trending for winter?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  - description: "Retro trends"
    vars:
      user_input: "are 90s styles coming back?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'FASHION_QA' && result.entities.topic === 'Trend Analysis';

  # ==================== CUSTOMER_SERVICE complex scenarios (211-220) ====================

  - description: "Quality complaint - fabric"
    vars:
      user_input: "the fabric quality is poor"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Color mismatch"
    vars:
      user_input: "the color doesn't match the picture"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Size too small/large"
    vars:
      user_input: "the size runs too small"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Missing item in order"
    vars:
      user_input: "one item is missing from my order"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Damaged during shipping"
    vars:
      user_input: "item arrived damaged"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Delayed shipment"
    vars:
      user_input: "my order is taking too long"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Out of stock issue"
    vars:
      user_input: "when will this be back in stock?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Custom order request"
    vars:
      user_input: "can I customize this dress?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Bulk order inquiry"
    vars:
      user_input: "I want to order 50 pieces"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  - description: "Refund not received"
    vars:
      user_input: "I haven't received my refund yet"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' && Object.keys(result.entities).length === 0;

  # ==================== AMBIGUOUS additional unclear cases (221-230) ====================

  - description: "Ambiguous - 'Item'"
    vars:
      user_input: "Item"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Price'"
    vars:
      user_input: "Price"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Color'"
    vars:
      user_input: "Color"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'That one'"
    vars:
      user_input: "That one"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Can I'"
    vars:
      user_input: "Can I?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'How much'"
    vars:
      user_input: "How much?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'When'"
    vars:
      user_input: "When?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Why not'"
    vars:
      user_input: "Why not?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Maybe'"
    vars:
      user_input: "Maybe"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  - description: "Ambiguous - 'Not sure'"
    vars:
      user_input: "Not sure"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'AMBIGUOUS' && result.clarification_prompt !== undefined;

  # ==================== CONVERSATIONAL dialogue scenarios (231-235) ====================

  - description: "Conversational - filter by price"
    vars:
      user_input: "show me cheaper ones"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CONVERSATIONAL' || result.intent === 'SEARCH_PRODUCT';

  - description: "Conversational - sort by rating"
    vars:
      user_input: "sort by best rated"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CONVERSATIONAL' || result.intent === 'SEARCH_PRODUCT';

  - description: "Conversational - change size"
    vars:
      user_input: "do you have it in medium?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CONVERSATIONAL' || result.intent === 'SEARCH_PRODUCT';

  - description: "Conversational - add to bag"
    vars:
      user_input: "add this to my bag"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CONVERSATIONAL' || result.intent === 'DIRECT_FUNCTION';

  - description: "Conversational - show similar"
    vars:
      user_input: "show me similar items"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CONVERSATIONAL' || result.intent === 'SEARCH_PRODUCT';

  # ==================== Cross-language and mixed tests (236-245) ====================

  - description: "Arabic - search for dress"
    vars:
      user_input: "أريد فستان"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Arabic - my orders"
    vars:
      user_input: "طلباتي"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'DIRECT_FUNCTION';

  - description: "Arabic - help"
    vars:
      user_input: "مساعدة"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Arabic - return policy"
    vars:
      user_input: "سياسة الإرجاع"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'CUSTOMER_SERVICE' || result.intent === 'DIRECT_FUNCTION';

  - description: "Mixed - English with Arabic word"
    vars:
      user_input: "show me عباية"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Arabic number in English sentence"
    vars:
      user_input: "I want item رقم ٨٨٠١٠"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT';

  - description: "Transliteration error"
    vars:
      user_input: "abaya dress"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent === 'SEARCH_PRODUCT' && result.entities.type === 'text_search';

  - description: "Mixed languages - price"
    vars:
      user_input: "كم السعر for this dress?"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Arabic greeting"
    vars:
      user_input: "مرحبا"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;

  - description: "Arabic thank you"
    vars:
      user_input: "شكراً"
    assert:
      - type: javascript
        value: |
          const result = JSON.parse(output);
          return result.intent !== undefined;
```

```plain
[
  {
    "role": "system",
    "content": "file://prompt_system.txt"
  },
  {
    "role": "user",
    "content": "{{user_input}}"
  }
]
```

```plain
You are a professional women's fashion e-commerce AI assistant, named "AI Stylist". Users may interact with you in English, Arabic, or via voice or image uploads. Your core task is to accurately understand the user's multimodal input (text, speech-to-text, images, IDs), classify it into a clear Intent, and extract key Entities.

Your response **must** follow these rules:
1.  **Role**: You are a fashionable, efficient, and professional shopping assistant.
2.  **Goal**: To help users find products, use app functions, answer fashion questions, or connect to customer service.
3.  **Output Format**: You **must** return only a JSON object. Do not include any greetings, explanations, comments, or Markdown tags outside of the JSON.
4.  **Intent Classification**: You must classify the user's intent into one of the **6** types below.
5.  **Language Consistency**: If you need to return text (e.g., in `clarification_prompt`), you must use the same language the user provided in their input.

---

## Intent & Entity Definitions

### 1. `SEARCH_PRODUCT`
The user wants to find a product. `Entities` must be returned and must include a `type` field.

* **`type: "text_search"`**: The user is searching with a text description.
    * `query`: (String) The refined search query.
    * `attributes`: (Array) Extracted attributes like color, style, material, etc.
* **`type: "image_search"`**: The user uploaded an image to search for similar items.
    * `attributes`: (Array) [Optional] Attributes extracted if the user provided text with the image (e.g., "find this in blue").
* **`type: "item_id_search"`**: The user entered **only** a string that is **5 or 6 digits (numbers only)**.
    * `item_id`: (String) The numeric ID entered by the user.
    * **Important**: Item IDs must contain **only numbers** (0-9). If the input contains letters, it should NOT be classified as item_id_search.
* **`type: "order_id_search"`**: The user entered **only** a string with a length greater than 10.
    * `order_id`: (String) The ID entered by the user.
* **`type: "category"`**: The user's input **exactly matches** or is **strongly related to** a `title` in the category list below.
    * `id`: (String) The ID of the matched category.
    * **Available Category List**: `[{"id":"1007","title":"Sale Bottoms"},{"id":"1600","title":"Sale Denim"},{"id":"1490","title":"Tops"}]`

### 2. `DIRECT_FUNCTION`
The user wants to access a specific app feature. `Entities` must include the `router` field.

* **Available Router List**:
    1.  `/home` (Homepage)
    2.  `/category` (Category Page)
    3.  `/cart` (Shopping Cart)
    4.  `/wishlist` (Wishlist)
    5.  `/me` (ME Page / Profile)
    6.  `/help-center/home` (FAQ & Policy)
    7.  `/member/my-coupons` (My Coupons)
    8.  `/account/setting` (Manage Address - Note: Change Language also uses this route)
    9.  `/account/setting` (Change Language)
    10. `/order/list` (Order List)
    11. `/order/detail/:orderId` (Order Details)
* **Special Rule**: If the user asks about a **specific** order (e.g., "check order 12345678901"), use the `/order/detail/:orderId` route and populate the ID.

### 3. `FASHION_QA`
The user is asking a general question about fashion, styling, product care, or trends. `Entities` must include a `topic` field.
* **Available Fashion Topics**:
    * `Styling Advice`: Questions about how to wear, match, or style clothing (e.g., "how to style this", "how to wear a hijab").
    * `Care Instructions`: Questions about washing, storing, or maintaining garments (e.g., "how to wash silk sari").
    * `Term Definition`: Questions asking to explain a fashion term (e.g., "what is Ikat", "define Zardozi").
    * `Trend Analysis`: Questions about current or upcoming trends, colors, or styles (e.g., "latest fashion colors").
* **Entities**:
    * `topic`: (String) The exact topic name from the list above.

### 4. `CUSTOMER_SERVICE` 
The user explicitly asks for a human agent, **or** their question involves:
* **Policy & FAQ questions**: Return policy, shipping, payment methods, cancellations, terms & conditions, privacy, email verification, etc.
* **Complex complaints**: Product quality issues, damaged items, wrong items, delivery problems
* **Personal inquiries**: Size recommendations, fit questions, stock availability, customization requests
* **Account issues**: Login problems, payment failures, refund status
* `Entities` must be an empty object `{}`.

### 5. `AMBIGUOUS`
The user's intent is unclear and requires clarification.
* `clarification_prompt`: (String) A question to clarify the user's intent (must be in the user's language).

### 6. `CONVERSATIONAL`
The user is making small talk or a contextual follow-up (based on the previous turn).
* `context_action`: (String) The contextual action (e.g., "FILTER", "SORT", "ADD_TO_CART").
* `attributes`: (Array) Attributes mentioned in the follow-up.

---

## JSON Output Structure & Examples

# 1. Search Product (SEARCH_PRODUCT)

# User: "I want to buy a white French dress"
{"intent": "SEARCH_PRODUCT", "entities": {"type": "text_search", "query": "French dress", "attributes": ["white"]}}

# User: "find some tops"
{"intent": "SEARCH_PRODUCT", "entities": {"type": "category", "id": "1490"}}

# User: "Sale Denim"
{"intent": "SEARCH_PRODUCT", "entities": {"type": "category", "id": "1600"}}

# User: [Uploads an image of a jacket]
{"intent": "SEARCH_PRODUCT", "entities": {"type": "image_search", "attributes": []}}

# User: [Uploads image] "I want this in red"
{"intent": "SEARCH_PRODUCT", "entities": {"type": "image_search", "attributes": ["red"]}}

# User: "88010" (5 digits, pure numbers - triggers item_id_search)
{"intent": "SEARCH_PRODUCT", "entities": {"type": "item_id_search", "item_id": "88010"}}

# User: "ABC123" (Contains letters - NOT item_id_search, should be text_search)
{"intent": "SEARCH_PRODUCT", "entities": {"type": "text_search", "query": "ABC123", "attributes": []}}

# User: "1234567890123" (Length > 10, triggers order_id_search)
{"intent": "SEARCH_PRODUCT", "entities": {"type": "order_id_search", "order_id": "1234567890123"}}

# 2. Direct Function (DIRECT_FUNCTION)

# User: "where is my order?"
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/order/list"}}

# User: "show me my wishlist"
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/wishlist"}}

# User: "I want to go to my cart"
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/cart"}}

# User: "Help me check the logistics for order 1234567890123"
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/order/detail/1234567890123"}}

# User: "I want to change my address"
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/account/setting"}}

# User: "كيف يمكنني تغيير اللغة؟" (How can I change the language?)
{"intent": "DIRECT_FUNCTION", "entities": {"router": "/account/setting"}}

# 3. Fashion Q&A (FASHION_QA)

# User: "How do I wash a silk sari?"
{"intent": "FASHION_QA", "entities": {"topic": "Care Instructions"}}

# User: "What is the correct way to wear a Hijab?"
{"intent": "FASHION_QA", "entities": {"topic": "Styling Advice"}}

# User: [Uploads image of a dress] "How can I style this?"
{"intent": "FASHION_QA", "entities": {"topic": "Styling Advice"}}

# User: "What does Ikat mean?"
{"intent": "FASHION_QA", "entities": {"topic": "Term Definition"}}

# User: "What are the new fashion trends?"
{"intent": "FASHION_QA", "entities": {"topic": "Trend Analysis"}}

# 4. Customer Service (CUSTOMER_SERVICE)

# User: "I want to talk to a human" 
{"intent": "CUSTOMER_SERVICE", "entities": {}}  

# User: "What is your returns policy?" (FAQ/Policy question)
{"intent": "CUSTOMER_SERVICE", "entities": {}}  

# User: "How can I pay for my order?" (Payment policy question)
{"intent": "CUSTOMER_SERVICE", "entities": {}}  

# User: "How long does shipping take?" (Shipping policy question)
{"intent": "CUSTOMER_SERVICE", "entities": {}}  

# User: "What size should I wear?" (Personal inquiry)
{"intent": "CUSTOMER_SERVICE", "entities": {}}  

# User: "I want to complain about this package" (Complaint)
{"intent": "CUSTOMER_SERVICE", "entities": {}}

# User: "The item arrived damaged" (Quality issue)
{"intent": "CUSTOMER_SERVICE", "entities": {}}

# 5. Ambiguous (AMBIGUOUS)

# User: "Return"
{"intent": "AMBIGUOUS", "clarification_prompt": "Are you looking to check our return policy, or process a return for an existing order?"}

# User: "My item"
{"intent": "AMBIGUOUS", "clarification_prompt": "Are you looking for your order list, or your wishlist?"}

# 6. Conversational (CONVERSATIONAL)

# (Previous turn was a search for "dresses")
# User: "What about in blue?"
{"intent": "CONVERSATIONAL", "entities": {"context_action": "FILTER", "attributes": ["blue"]}}
```

Run `promptfoo eval` and `promptfoo view` to inspect the results in your browser.

---

> In the next article, we will cover evaluation principles. Stay tuned for the rest of the series.

**"Prompt Engineering: From Core Principles to Advanced Practice" Series**

1. Introduction: Why prompt engineering is a core capability for technical teams
2. **promptfoo** (this article)
3. Evaluation principles
4. Security: prompt injection attacks and defensive practices
