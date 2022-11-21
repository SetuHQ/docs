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

### Install VS code extensions

For easy syntax higlighting, install this [extension](https://marketplace.visualstudio.com/items?itemName=unifiedjs.vscode-mdx)

For documentation preview, install this [extension](https://marketplace.visualstudio.com/items?itemName=SetuDesign.docter-preview)

## Features

### MDX preview

-   Open any `.mdx` file in VS code, you should this icon to the top right. Click on it to preview the rendered version of MDX file.
-   Make edits to the file, save it and click again to open the updated version. (You can close the previous tab for better visibility)

![mdx-preview](https://user-images.githubusercontent.com/9695866/202152076-13c2a93a-7612-4e24-9644-6ec54825d8a5.png)

### Sidebar preview

-   Open `endpoints.json` file and you should this icon to the top right. Click on it to preview how the sidebar would look like for a product.
-   This loads a webview with a dropdown with all the available products, choose to view the sidebar

![sidebar-preview](https://user-images.githubusercontent.com/9695866/202152084-241e2a78-4ed4-4587-bc1c-101c0f6e7701.png)

### Menu Items

#### Very important step

-   Once you're done with all the editing of content, befoore you commit, you should run the `Build Menu Items` step.
-   Open `endpoints.json` file and you should this icon to the top right. Click on it to build all the menu items needed for the sidebar.
-   Once this step is done, you can now commit to your branch and raise a PR

![menu-items](https://user-images.githubusercontent.com/9695866/202152080-1af24b5c-cb22-49ab-bf20-cb37d3a959e3.png)

# API References

You can find API reference spec files for [Setu docs](https://docs.setu.co) in `/api-reference` folder

## Repo structure of `/api-references` folder

-   Each category is a folder with products as API reference spec files in JSON or YAML format.
-   All API reference files are in JSON or YAML format
