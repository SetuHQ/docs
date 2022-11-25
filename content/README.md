# Detailed guide on how to write content for Setu docs

## Sample content

### Sample MDX file

```
---
sidebar_title: Sample Page
page_title: Sample page — Setu Docs
order: 0
visible_in_sidebar: true
---

## This is heading 2
And this is a paragraph text
- And a bullet point, **in bold**
```

**As seen above, every MDX file has two main sections — frontmatter and the actual content**

### Frontmatter

Frontmatter is information about the page, helping the CMS to know what to do with page.

```
---
sidebar_title: Overview
page_title: Test product 1 Overview
order: 0
visible_in_sidebar: true
---
```

### Actual content

This is the content that is actually shown on the page when processed by the CMS. For help on Markdown syntax, refer this [Markdown cheatsheet](https://www.markdownguide.org/cheat-sheet/).

```
## This is heading 2
And this is a paragraph text
- And a bullet point, **in bold**
```

<br />

# Adding a new product category and a new product

Let's start with an example. We will—

-   Create a **product category** with name `Test category` and path `test-category`
-   Create two **products**
    -   Name `Test product 1`, path `test-product-1`
    -   Name `Test product 2`, path `test-product-2`
-   Create an **Overview page** for each product with some content in it

---

### Create a product category

Create a new folder with name, 'test-category'

---

### Create a product

Create two new folders with names `test-product-1` and `test-prodcut-2` inside `test-category` folder.

---

### Add an entry in endpoints.json

For the product category and the new products just created above, add a new object in the `endpoints.json` like this,

```
{
      "name": "Test category",
      "path": "test-category",
      "order": 4,
      "visible_in_sidebar": true,
      "children":
      [
        {
          "name": "Test product 1",
          "path": "test-product-1",
          "order": 0,
          "visible_in_sidebar": true
        },
        {
          "name": "Test product 2",
          "path": "test-product-2",
          "order": 1,
          "visible_in_sidebar": true
        }
      ]
  }
```

### Add some content

Create a file `overview.mdx` inside `test-product-1` and add some sample content like this—

```
---
sidebar_title: Sample Page
page_title: Sample page — Setu Docs
order: 0
visible_in_sidebar: true
---

## This is heading 2
And this is a paragraph text
- And a bullet point, **in bold**
```

Create a similar `mdx` file inside `test-product-2` and we are done!

<br />
<br />

# Using React components in MDX files

List of all components and their usage can be found by visiting https://docs.setu.co/sample-category/sample-product/sample-page

Code of these components can be found in `sample-category` folder in this repo
