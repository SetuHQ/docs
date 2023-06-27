# Setu Documentation : Content + API References

Monorepo of content and API reference of [Setu docs](https://docs.setu.co)

-   [Content](#content)
-   [API References](#api-references)

# Content

You can find content for [Setu docs](https://docs.setu.co) in `/content` folder

## Repo structure of `/content` folder

-   Each category is a folder with products as sub-folders and content files inside product folders.
-   All content files are MDX
-   `endpoints.json` - Object with categories and products in Setu docs
-   `redirects.json` - key-value pairs contains information about redirecting from one slug to another
-   `menuItems.json` contains fully nested object for the docs sidebar (DO NOT TOUCH)

## Content editing guide

Create a new branch and raise a PR for every edit you want to make to the documentation.

To edit any page, you can either,

-   clone this repo in your local and edit using VS Code
-   or just press `.` after logging into GitHub to open online VS Code

Cloning and editing in local is faster due to virtual workspace in online VS Code

Go through this [detailed guide](./content/README.md) on how to write content

### Install VS code extensions

For easy syntax higlighting, `VSCode MDX`

-   Install this [extension](https://marketplace.visualstudio.com/items?itemName=unifiedjs.vscode-mdx) from marketplace.
-   or you can install in VS Code by the extensions tab in the leftside bar or press `Shift + Cmd/Ctrl + X` and search for `MDX`

For documentation preview, `Docter Preview`

-   Install this [extension](https://marketplace.visualstudio.com/items?itemName=SetuDesign.docter-preview) from marketplace.
-   You can install in VS Code by the extensions tab in the leftside bar or press `Shift + Cmd/Ctrl + X` and search for `Docter Preview`

## Preview

Using the `Docter Preview` extension, we can preview content and sidebar changes. Please go through the [README](https://github.com/SetuHQ/vscode-docter-preview#readme) to learn about the features and follow the steps mentioned to use it.

# API References

You can find API reference spec files for [Setu docs](https://docs.setu.co) in `/api-reference` folder

## Repo structure of `/api-references` folder

-   Each category is a folder with products as API reference spec files in JSON or YAML format.
-   All API reference files are in JSON or YAML format

## Editing and viewing

You can now use Setu's pre-built editor to preview API references. [Visit the preview page](https://docs.setu.co/content-preview), copy your content and generate an API reference preview.

> Currently this only works for JSON files. Support for YAML is WIP and should be available soon.

# Versioning

To add versions to any product in our docs, these steps need to be followed:

## Update endpoints.json

Go to `endpoints.json`, add the following key-value pairs inside the product object

-   `versions` - an array of strings with the all the possible versions
-   `default_version` - a version string which denotes the default version to load on docs

Example:

```json
{
    "name": "Account Aggregator",
    "path": "account-aggregator",
    "order": 4,
    "versions": ["v1", "v2"],
    "default_version": "v2",
    "visible_in_sidebar": true
}
```

In future if there is a new version, `v1.5` which is not a default version,

We need to add `v1.5` to the versions array

## Update content

To update content for a product based on the versions,

-   Existing content in the root of product folder corresponds to the default version documentation. You can make changes to it.
-   Create a new folder with older version and add content of previous version

Example:

In case of Account Aggregator, if you see the product folder,

-   the files in the root correspond to version `v2` as it is the default version.
-   there is a folder `v1` which corresponds to the older version documentation. Put all the `v1` documentation into this folder.

```bash
.
├── ...
├── account-aggregator
│   ├── overview.mdx
│   ├── quickstart.mdx
│   ├── v1
│   │   ├── overview.mdx
│   │   ├── quickstart.mdx
│   │   └── ...
│   └── ...
└── ...
```

In future if there is a new version, `v1.5`, which is not a default version,

We need to add a folder `v1.5` and add contents of that version into it.

## Update API Reference

To update API references based on versions,

-   In API reference folder, `{product}.json` corresponds to the default version mentioned
-   Create a new file with name in the format, `{product}_{version}.json`. Here `version` denotes the verion other other than `default_version`

Example:

In case of Account Aggregator, in api-references folder,

-   `account-aggregator.json` corresponds to the default version `v2`
-   `account-aggregator_v1.json` corresponds to a version other than default version, `v1`

```bash
.
├── ...
├── api-references
│   ├── data
│   │   ├── account-aggregator.json
│   │   ├── account-aggregator_v1.json
│   │   └── ...
│   └── ...
└── ...
```

In future if there is a new version, `v1.5` which is not a default version,

We need to add a file `account-aggregator_v1.5.json` and add API reference into it
