# React Template

This folder contains modular React views for the CSA storefront.

Files
- GuestView.jsx: guest-only view (plan-first flow).
- MemberView.jsx: member view (pantry-first flow + account panel).
- components/: shared, modular sections you can reorder in Storefront.jsx.
- data.js: copy and swap data, including stock image URLs.
- styles.css: global styles used by both views.

Notes
- The image URLs use Unsplash stock sources with sizing parameters.
- The guest view shows the plan chooser and hides the pantry section.
- The member view shows the pantry section and account settings block.
