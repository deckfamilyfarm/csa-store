import React from "react";

export function HerdshareBanner({ herdshare }) {
  return (
    <section className="section tight">
      <div className="container">
        <div className="banner">
          <strong>{herdshare.title}</strong>
          <div>{herdshare.body}</div>
        </div>
      </div>
    </section>
  );
}
