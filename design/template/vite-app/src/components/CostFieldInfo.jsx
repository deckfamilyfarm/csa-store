import React from "react";
import { FieldInfo } from "./InventoryFieldInfo.jsx";

export function CostFieldInfo() {
  return <FieldInfo label="Cost">
    The amount the sales enterprise pays the farmer or vendor, per lb or each as shown.
    For carrots purchased at $1/lb, enter $1.
    For Deck Family Farm beef, use the Beef program’s charge per pound of actual packaged beef—not live or hanging weight.
    This charge includes the producer’s base cost plus a margin to help keep that enterprise sustainable.
    The sales enterprise’s retail markup is added separately.
  </FieldInfo>;
}
