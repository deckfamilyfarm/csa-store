import React from "react";

export function AnnouncementBar({ announcement }) {
  return (
    <div className="announcement">
      <div className="container">
        <div>{announcement.left}</div>
        <div>{announcement.right}</div>
      </div>
    </div>
  );
}
