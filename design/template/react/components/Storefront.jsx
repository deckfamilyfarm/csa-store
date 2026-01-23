import React from "react";
import {
  accountPanel,
  announcement,
  categories,
  csaPlanTiles,
  delivery,
  dropSite,
  herdshare,
  hero,
  navLinks,
  plans,
  productDetail,
  products,
  recipes,
  seasonalHighlights,
} from "../data";
import { AccountPanelSection } from "./AccountPanelSection.jsx";
import { AnnouncementBar } from "./AnnouncementBar.jsx";
import { CsaPlansSection } from "./CsaPlansSection.jsx";
import { DeliverySection } from "./DeliverySection.jsx";
import { FooterSection } from "./FooterSection.jsx";
import { HeaderNav } from "./HeaderNav.jsx";
import { HerdshareBanner } from "./HerdshareBanner.jsx";
import { HeroSection } from "./HeroSection.jsx";
import { PantryCategories } from "./PantryCategories.jsx";
import { PlanChooser } from "./PlanChooser.jsx";
import { ProductDetailSection } from "./ProductDetailSection.jsx";
import { ProductGrid } from "./ProductGrid.jsx";
import { RecipesSection } from "./RecipesSection.jsx";
import { SeasonalHighlights } from "./SeasonalHighlights.jsx";

export function Storefront({ userState = "guest" }) {
  const isGuest = userState === "guest";

  return (
    <div className={`page ${isGuest ? "state-guest" : "state-member"}`}>
      <AnnouncementBar announcement={announcement} />
      <HeaderNav navLinks={navLinks} />

      <main>
        <HeroSection hero={hero} />
        {isGuest ? <PlanChooser plans={plans} /> : <PantryCategories categories={categories} />}
        <CsaPlansSection csaPlanTiles={csaPlanTiles} />
        <SeasonalHighlights seasonalHighlights={seasonalHighlights} />
        <ProductGrid products={products} />
        <HerdshareBanner herdshare={herdshare} />
        <DeliverySection delivery={delivery} dropSite={dropSite} />
        <ProductDetailSection productDetail={productDetail} />
        <RecipesSection recipes={recipes} />
        {!isGuest && <AccountPanelSection accountPanel={accountPanel} dropSite={dropSite} />}
      </main>

      <FooterSection />
    </div>
  );
}
